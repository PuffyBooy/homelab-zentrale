import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@hz/shared';
import { isProtectedContainer, PROTECTED_ROLES } from '../src/actions/protected.js';
import type { UpdateInspect } from '../src/actions/container-update.js';
import { createLogger } from '../src/log.js';
import { swapAgent } from '../src/update/agent-swap.js';
import { readJournal, writeJournal, type Journal } from '../src/update/journal.js';
import { buildHelperCreate, mountSource } from '../src/update/helper.js';
import { replaceContainer, waitHealthy } from '../src/update/replace.js';
import { flushResults, pendingResults, writeResult } from '../src/update/results.js';
import { UpdateService } from '../src/update/service.js';
import { containerIdFromMountinfo } from '../src/update/target.js';
import { imageVersion } from '../src/update/versions.js';
import { rpc, setupAdmin } from './admin-helpers.js';
import {
  AGENT_ID,
  AGENT_REF,
  CORE_ID,
  CORE_REF,
  NEW_ID,
  NEW_IMG,
  OLD_IMG,
  agentInfo,
  coreInfo,
  fakeDocker,
  img,
  type FakeOpts,
} from './update-fakes.js';

const log = createLogger('error', () => undefined);
const noWait = { sleep: async () => undefined, timeoutMs: 0, stableMs: 0 };
const RUN = 'run_abcdefgh';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hz-upd-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const MOUNTINFO = `1 0 8:1 /var/lib/docker/containers/${AGENT_ID}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`;

function service(o: FakeOpts = {}, emit: (m: AgentEvent) => boolean = () => true) {
  const f = fakeDocker(o);
  // The fake agent's data volume is mounted at the test's data dir.
  void (f.docker.getContainer(AGENT_ID).inspect() as Promise<UpdateInspect>).then((info) => {
    for (const m of info.Mounts ?? []) if (m.Destination === '/data') m.Destination = dataDir;
  });
  const sent: AgentEvent[] = [];
  const svc = new UpdateService({
    docker: f.docker,
    dataDir,
    dockerSocket: '/var/run/docker.sock',
    log,
    emit: (m) => {
      const ok = emit(m);
      if (ok) sent.push(m);
      return ok;
    },
    target: { readMountinfo: async () => MOUNTINFO, hostname: 'heimserver' },
    wait: noWait,
    statPath: async (p) =>
      p === dataDir
        ? { uid: 1000, gid: 1000, mode: 0o40700 }
        : { uid: 0, gid: 988, mode: 0o140660 },
    setTimer: () => undefined,
  });
  return { svc, sent, ...f };
}

describe('protected roles', () => {
  it('include the updater helper', () => {
    expect([...PROTECTED_ROLES].sort()).toEqual(['agent', 'core', 'updater']);
    expect(isProtectedContainer({ id: 'x', labels: { 'hz.role': 'updater' } }, 'host')).toBe(true);
  });

  it('container.* still refuses core and agent (fake docker through the dispatcher)', async () => {
    const f = fakeDocker();
    const { d, ctx } = setupAdmin();
    ctx.host.docker = f.docker as unknown as NonNullable<typeof ctx.host.docker>;
    for (const id of [CORE_ID, AGENT_ID]) {
      const res = await d.handle(rpc('container.update', { id }));
      expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    }
    expect(f.calls.some((c) => c.startsWith('pull') || c.startsWith('create'))).toBe(false);
  });
});

describe('update.check', () => {
  it('pulls only the tag the target container runs, never anything from the request', async () => {
    const s = service();
    const r = await s.svc.check('core');
    expect(s.calls.filter((c) => c.startsWith('pull'))).toEqual([`pull ${CORE_REF}`]);
    expect(r).toEqual({
      target: 'core',
      ref: CORE_REF,
      current: {
        imageId: OLD_IMG,
        version: 'sha-1111111',
        revision: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
        created: '2026-11-20T10:00:00.123Z',
      },
      available: {
        imageId: NEW_IMG,
        version: 'sha-2222222',
        revision: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
        created: '2026-11-20T10:00:00.123Z',
      },
      pulled: true,
    });
    const a = await s.svc.check('agent');
    expect(a.ref).toBe(AGENT_REF);
    expect(s.calls.filter((c) => c.startsWith('pull'))).toEqual([
      `pull ${CORE_REF}`,
      `pull ${AGENT_REF}`,
    ]);
    expect(s.calls.some((c) => /^(create|stop|rename|remove)/.test(c))).toBe(false);
  });

  it('extra params (an image) are refused by the schema', async () => {
    const { d } = setupAdmin();
    for (const params of [
      { target: 'core', image: 'evil/image:latest' },
      { target: 'web' },
      { target: 'updater' },
    ]) {
      const res = await d.handle(rpc('update.check', params));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    }
    const res = await d.handle(rpc('update.apply', { target: 'agent', runId: RUN, ref: 'x:1' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });

  it('same image: available null; failed pull: pulled false', async () => {
    const same = service({ remote: { [CORE_REF]: OLD_IMG } });
    expect(await same.svc.check('core')).toMatchObject({ available: null, pulled: true });
    const off = service({ pullFails: true });
    expect(await off.svc.check('core')).toMatchObject({ available: null, pulled: false });
  });

  it('no core container: not_found; two: failed', async () => {
    await expect(service({ noCore: true }).svc.check('core')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service({ extraCores: 1 }).svc.check('core')).rejects.toMatchObject({
      code: 'failed',
    });
  });

  it('refuses a target that runs an image id', async () => {
    const s = service();
    const info = coreInfo();
    info.Config.Image = OLD_IMG;
    s.docker.getContainer = ((orig) => (id: string) => {
      const c = orig(id);
      return id === CORE_ID ? { ...c, inspect: async () => info } : c;
    })(s.docker.getContainer.bind(s.docker));
    await expect(s.svc.check('core')).rejects.toMatchObject({ code: 'failed' });
    expect(s.calls.some((c) => c.startsWith('pull'))).toBe(false);
  });
});

describe('update.apply core', () => {
  it('answers at once, replaces the core, waits for healthy, sends updated', async () => {
    const s = service();
    expect(await s.svc.apply('core', RUN)).toEqual({ accepted: true });
    await s.svc.lastRun;
    expect(s.calls).toEqual([
      `pull ${CORE_REF}`,
      'rename core homelab-zentrale-core-1-hz-old',
      `create homelab-zentrale-core-1 ${CORE_REF}`,
      'stop core',
      'start new',
      'remove core',
    ]);
    // Compose labels are carried over (compose keeps owning the container).
    expect(s.created[0]?.Labels?.['com.docker.compose.project']).toBe('homelab-zentrale');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.event).toMatchObject({
      kind: 'update_result',
      runId: RUN,
      target: 'core',
      outcome: 'updated',
      from: { imageId: OLD_IMG, version: 'sha-1111111' },
      to: { imageId: NEW_IMG, version: 'sha-2222222' },
    });
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('a second apply while one runs is busy', async () => {
    const s = service();
    await s.svc.apply('core', RUN);
    await expect(s.svc.apply('agent', 'run_zzzzzzzz')).rejects.toMatchObject({ code: 'busy' });
    await expect(s.svc.apply('core', 'run_zzzzzzzz')).rejects.toMatchObject({ code: 'busy' });
    await s.svc.lastRun;
    expect(await s.svc.apply('agent', 'run_yyyyyyyy')).toEqual({ accepted: true });
    await s.svc.lastRun;
  });

  it('unhealthy new core: rolled back, old core runs again', async () => {
    const s = service({ newHealth: 'unhealthy' });
    await s.svc.apply('core', RUN);
    await s.svc.lastRun;
    expect(s.calls.slice(-3)).toEqual([
      'remove new',
      'rename core homelab-zentrale-core-1',
      'start core',
    ]);
    expect(s.running.has(CORE_ID)).toBe(true);
    expect(s.sent[0]?.event).toMatchObject({
      outcome: 'rolled_back',
      message: 'health check failed; old container restored',
    });
  });

  it('rollback that cannot restore the old core is failed and says so', async () => {
    const s = service({ newHealth: 'exit', failAt: 'start-old' });
    await s.svc.apply('core', RUN);
    await s.svc.lastRun;
    expect(s.sent[0]?.event).toMatchObject({
      outcome: 'failed',
      message: expect.stringMatching(/^rollback failed: .*starting the old container failed/),
    });
  });

  it('create fails: failed, old core restored, never stopped', async () => {
    const s = service({ failAt: 'create' });
    await s.svc.apply('core', RUN);
    await s.svc.lastRun;
    expect(s.calls).not.toContain('stop core');
    expect(s.sent[0]?.event).toMatchObject({
      outcome: 'failed',
      message: 'update failed at create; old container restored',
    });
  });

  it('same image: up_to_date, nothing replaced', async () => {
    const s = service({ remote: { [CORE_REF]: OLD_IMG } });
    await s.svc.apply('core', RUN);
    await s.svc.lastRun;
    expect(s.calls).toEqual([`pull ${CORE_REF}`]);
    expect(s.sent[0]?.event).toMatchObject({ outcome: 'up_to_date' });
  });

  it('not_found before accepting when there is no core', async () => {
    const s = service({ noCore: true });
    await expect(s.svc.apply('core', RUN)).rejects.toMatchObject({ code: 'not_found' });
    expect(await s.svc.apply('agent', RUN)).toEqual({ accepted: true });
  });
});

describe('result persistence', () => {
  it('the result file exists before the send and stays while offline', async () => {
    let online = false;
    const seenFiles: string[][] = [];
    const s = service({}, () => false);
    // Replace emit: record what is on disk at the moment of sending.
    const svc = new UpdateService({
      docker: s.docker,
      dataDir,
      dockerSocket: '/var/run/docker.sock',
      log,
      emit: () => {
        void readdir(dataDir).then((f) => seenFiles.push(f));
        return online;
      },
      target: { readMountinfo: async () => MOUNTINFO },
      wait: noWait,
    });
    await svc.apply('core', RUN);
    await svc.lastRun;
    await new Promise((r) => setTimeout(r, 20));
    // The result is on disk when the send is tried (the journal of the swap is there too).
    expect(seenFiles[0]).toContain(`update-result-${RUN}.json`);
    expect(await readdir(dataDir)).toEqual([`update-result-${RUN}.json`]);

    // Reconnect: welcome -> flush sends it and deletes the file.
    online = true;
    expect(await svc.flush()).toBe(1);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('flush sends oldest first and drops invalid files', async () => {
    await writeResult(dataDir, {
      kind: 'update_result',
      runId: 'run_bbbbbbbb',
      target: 'agent',
      outcome: 'updated',
    });
    await writeFile(
      path.join(dataDir, 'update-result-run_cccccccc.json'),
      '{"ts":"x","event":{"kind":"denied"}}',
    );
    await writeFile(path.join(dataDir, 'update-result-run_dddddddd.json'), 'not json');
    expect((await pendingResults(dataDir)).map((p) => p.message.event)).toEqual([
      expect.objectContaining({ runId: 'run_bbbbbbbb' }),
    ]);
    const out: AgentEvent[] = [];
    expect(await flushResults(dataDir, (m) => (out.push(m), true))).toBe(1);
    expect(out[0]).toMatchObject({
      type: 'event',
      event: { kind: 'update_result', outcome: 'updated' },
    });
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('a file whose name does not match its runId is dropped', async () => {
    await writeResult(dataDir, {
      kind: 'update_result',
      runId: 'run_bbbbbbbb',
      target: 'agent',
      outcome: 'updated',
    });
    const { rename } = await import('node:fs/promises');
    await rename(
      path.join(dataDir, 'update-result-run_bbbbbbbb.json'),
      path.join(dataDir, 'update-result-run_eeeeeeee.json'),
    );
    expect(await pendingResults(dataDir)).toEqual([]);
  });
});

describe('agent update: helper container', () => {
  it('starts the helper from the OLD image with minimal rights', async () => {
    const s = service();
    expect(await s.svc.apply('agent', RUN)).toEqual({ accepted: true });
    await s.svc.lastRun;
    expect(s.calls).toEqual([`pull ${AGENT_REF}`, 'create helper', 'start helper']);
    const h = s.created[0];
    expect(h).toBeDefined();
    if (!h) return;
    expect(h.Image).toBe(OLD_IMG);
    expect(h.Cmd).toEqual(['node', 'dist/updater.js']);
    expect(h.Labels).toMatchObject({ 'hz.role': 'updater' });
    expect(h.Healthcheck).toEqual({ Test: ['NONE'] });
    const hc = h.HostConfig ?? {};
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd).toBeUndefined();
    // Restarted after a crash (resumes from its journal) instead of AutoRemove.
    expect(hc.AutoRemove).toBeUndefined();
    expect(hc.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 });
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.NetworkMode).toBe('none');
    expect(hc.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(hc.Binds).toEqual([
      '/var/run/docker.sock:/var/run/docker.sock',
      'homelab-agent_agent-data:/data',
    ]);
    expect(hc.Mounts).toBeUndefined();
    expect(hc.PidMode).toBeUndefined();
    expect(hc.Devices).toBeUndefined();
    expect(h.User).toBe('1000:1000');
    expect(hc.GroupAdd).toEqual(['988']);
    expect(h.Env).toEqual([
      'NODE_ENV=production',
      `HZ_UPDATER_TARGET=${AGENT_ID}`,
      `HZ_UPDATER_RUN_ID=${RUN}`,
      `HZ_UPDATER_IMAGE=${NEW_IMG}`,
      'HZ_UPDATER_DATA=/data',
    ]);
    // No token, no core URL in the helper env.
    expect(JSON.stringify(h)).not.toMatch(/TOKEN|HZ_CORE_URL/);
    // The agent itself sends nothing yet: the helper writes the result.
    expect(s.sent).toEqual([]);
  });

  it('root-owned /data: runs as root without capabilities; no group-rw socket: only DAC_OVERRIDE', () => {
    const base = {
      runId: RUN,
      agent: agentInfo(),
      newImageId: NEW_IMG,
      dockerSocket: '/var/run/docker.sock',
      dataDir: '/data',
    };
    const root = buildHelperCreate({
      ...base,
      dataOwner: { uid: 0, gid: 0 },
      socket: { gid: 988, mode: 0o140660 },
    });
    expect(root.User).toBe('0:0');
    expect(root.HostConfig?.CapAdd).toBeUndefined();
    const fallback = buildHelperCreate({
      ...base,
      dataOwner: { uid: 1000, gid: 1000 },
      socket: { gid: 0, mode: 0o140600 },
    });
    expect(fallback.User).toBe('0:0');
    expect(fallback.HostConfig?.CapAdd).toEqual(['DAC_OVERRIDE']);
    expect(fallback.HostConfig?.CapDrop).toEqual(['ALL']);
  });

  it('refuses odd mount sources and a missing data mount', () => {
    const info = agentInfo();
    info.Mounts = [{ Type: 'bind', Source: '/x:/etc', Destination: '/data' }];
    expect(mountSource(info, '/data')).toBeNull();
    expect(() =>
      buildHelperCreate({
        runId: RUN,
        agent: info,
        newImageId: NEW_IMG,
        dockerSocket: '/var/run/docker.sock',
        dataDir: '/data',
        dataOwner: { uid: 0, gid: 0 },
        socket: { gid: 0, mode: 0o140660 },
      }),
    ).toThrow();
  });

  it('helper start fails: result failed, saved and sent', async () => {
    const s = service({ failAt: 'helper-start' });
    await s.svc.apply('agent', RUN);
    await s.svc.lastRun;
    expect(s.calls).toContain('remove helper');
    expect(s.sent[0]?.event).toMatchObject({
      outcome: 'failed',
      message: 'could not start the updater helper',
    });
  });

  it('own container from mountinfo (host network: the hostname is the host name)', () => {
    expect(containerIdFromMountinfo(MOUNTINFO)).toBe(AGENT_ID);
    expect(containerIdFromMountinfo('1 0 8:1 / / rw - ext4 /dev/sda1 rw\n')).toBeNull();
    const two = `${MOUNTINFO}2 0 8:1 /var/lib/docker/containers/${CORE_ID}/hosts /x rw - ext4 /dev/sda1 rw\n`;
    expect(containerIdFromMountinfo(two)).toBeNull();
  });
});

describe('updater helper: swapAgent', () => {
  const env = () => ({
    HZ_UPDATER_TARGET: AGENT_ID,
    HZ_UPDATER_RUN_ID: RUN,
    HZ_UPDATER_IMAGE: NEW_IMG,
    HZ_UPDATER_DATA: dataDir,
  });
  async function swap(o: FakeOpts) {
    const f = fakeDocker(o);
    await f.docker.pull(AGENT_REF); // the agent pulled before starting the helper
    f.calls.length = 0;
    const written: unknown[] = [];
    const r = await swapAgent(f.docker, env(), {
      log,
      wait: noWait,
      write: async (_d, e) => {
        written.push(e);
      },
    });
    return { r, f, written };
  }

  it('healthy new agent: old removed, updated written', async () => {
    const { r, f, written } = await swap({});
    expect(f.calls).toEqual([
      'rename old homelab-agent-hz-old',
      `create homelab-agent ${AGENT_REF}`,
      'stop old',
      'start new',
      'remove old',
    ]);
    expect(r).toMatchObject({
      outcome: 'updated',
      from: { imageId: OLD_IMG },
      to: { imageId: NEW_IMG },
    });
    expect(written).toEqual([r]);
  });

  it('new agent never connects (unhealthy): rolled back to the old agent', async () => {
    const { r, f } = await swap({ newHealth: 'unhealthy' });
    expect(f.calls.slice(-3)).toEqual(['remove new', 'rename old homelab-agent', 'start old']);
    expect(f.running.has(AGENT_ID)).toBe(true);
    expect(r).toMatchObject({ outcome: 'rolled_back' });
  });

  it('still starting after the timeout: rolled back', async () => {
    const { r } = await swap({ newHealth: 'starting' });
    expect(r).toMatchObject({
      outcome: 'rolled_back',
      message: expect.stringMatching(/not healthy within/),
    });
  });

  it('rename back fails: failed with "rollback failed"', async () => {
    const { r } = await swap({ newHealth: 'exit', failAt: 'rename-back' });
    expect(r).toMatchObject({
      outcome: 'failed',
      message: expect.stringMatching(/^rollback failed/),
    });
  });

  it('refuses when the tag moved to another image meanwhile', async () => {
    const f = fakeDocker();
    const r = await swapAgent(f.docker, env(), { log, wait: noWait, write: async () => undefined });
    expect(r).toMatchObject({ outcome: 'failed', message: 'image tag changed during the update' });
    expect(f.calls.some((c) => c.startsWith('rename'))).toBe(false);
  });

  it('never replaces the core even with its id', async () => {
    const f = fakeDocker();
    await f.docker.pull(CORE_REF);
    const r = await swapAgent(
      f.docker,
      { ...env(), HZ_UPDATER_TARGET: CORE_ID },
      { log, wait: noWait, write: async () => undefined },
    );
    expect(r).toMatchObject({ outcome: 'failed', message: 'target is not the agent container' });
  });
});

describe('health wait', () => {
  const docker = (states: object[]) => {
    let i = 0;
    return {
      getContainer: () => ({
        inspect: async () => states[Math.min(i++, states.length - 1)],
        rename: async () => undefined,
        stop: async () => undefined,
        start: async () => undefined,
        remove: async () => undefined,
      }),
    };
  };
  it('waits through starting until healthy', async () => {
    const d = docker([
      { State: { Running: true, Health: { Status: 'starting' } } },
      { State: { Running: true, Health: { Status: 'healthy' } } },
    ]);
    expect(await waitHealthy(d, 'x', { sleep: async () => undefined, timeoutMs: 1e9 })).toEqual({
      ok: true,
    });
  });

  it('without a health check: running for the stable time without restarts', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const d = docker([{ State: { Running: true }, RestartCount: 0 }]);
    expect(await waitHealthy(d, 'x', { sleep, now, pollMs: 5000, stableMs: 30_000 })).toEqual({
      ok: true,
    });
    expect(t).toBe(30_000);
    const restarted = docker([
      { State: { Running: true }, RestartCount: 0 },
      { State: { Running: true }, RestartCount: 1 },
    ]);
    expect(await waitHealthy(restarted, 'x', { sleep, now, pollMs: 5000 })).toMatchObject({
      ok: false,
    });
  });
});

describe('replace without a running container', () => {
  it('creates the new one and does not start it', async () => {
    const f = fakeDocker();
    const info = coreInfo();
    info.State = { Running: false };
    const r = await replaceContainer(f.docker, info, CORE_REF, {
      log,
      waitReady: async () => ({ ok: false, reason: 'x' }),
    });
    expect(r.outcome).toBe('updated');
    expect(f.calls.some((c) => c.startsWith('start'))).toBe(false);
  });
});

describe('versions from OCI labels', () => {
  it('drops invalid label values instead of failing', () => {
    const v = imageVersion(
      img(NEW_IMG, 'bad version with spaces', {
        'org.opencontainers.image.revision': 'NOT-HEX',
        'org.opencontainers.image.created': '2026-11-21T08:00:00+01:00',
      }),
    );
    expect(v).toEqual({ imageId: NEW_IMG, created: '2026-11-21T07:00:00.000Z' });
  });

  it('uppercase revision is normalized; bad image ids give null', () => {
    expect(
      imageVersion({
        Id: NEW_IMG,
        Config: { Labels: { 'org.opencontainers.image.revision': 'ABCDEF1' } },
      }),
    ).toEqual({ imageId: NEW_IMG, revision: 'abcdef1' });
    expect(imageVersion({ Id: 'sha256:short' })).toBeNull();
    expect(imageVersion(null)).toBeNull();
  });
});

describe('crash safety: journal, resume, reconcile', () => {
  const OTHER = 'b'.repeat(64);
  const env = () => ({
    HZ_UPDATER_TARGET: AGENT_ID,
    HZ_UPDATER_RUN_ID: RUN,
    HZ_UPDATER_IMAGE: NEW_IMG,
    HZ_UPDATER_DATA: dataDir,
  });
  const journal = (over: Partial<Journal> = {}): Journal => ({
    runId: RUN,
    target: 'agent',
    phase: 'stopped',
    oldId: AGENT_ID,
    oldName: 'homelab-agent',
    newId: NEW_ID,
    wasRunning: true,
    from: { imageId: OLD_IMG },
    to: { imageId: NEW_IMG },
    ts: new Date().toISOString(),
    ...over,
  });
  const result = async () =>
    (await pendingResults(dataDir)).map((p) => p.message.event as Record<string, unknown>);

  it('the helper journals every step before acting and ends with done', async () => {
    const f = fakeDocker();
    await f.docker.pull(AGENT_REF);
    const phases: string[] = [];
    const origCreate = f.docker.createContainer.bind(f.docker);
    f.docker.createContainer = async (opts) => {
      phases.push(`create sees journal ${(await readJournal(dataDir, RUN))?.phase}`);
      return origCreate(opts);
    };
    const r = await swapAgent(f.docker, env(), { log, wait: noWait });
    expect(r).toMatchObject({ outcome: 'updated' });
    expect(phases).toEqual(['create sees journal renamed']);
    expect((await readJournal(dataDir, RUN))?.phase).toBe('done');
    expect(await result()).toEqual([expect.objectContaining({ outcome: 'updated' })]);
  });

  it('a restarted helper after a finished run does nothing', async () => {
    const f = fakeDocker();
    await f.docker.pull(AGENT_REF);
    await swapAgent(f.docker, env(), { log, wait: noWait });
    f.calls.length = 0;
    expect(await swapAgent(f.docker, env(), { log, wait: noWait })).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('a helper restarted mid-swap (new not started) rolls back to the old agent', async () => {
    const f = fakeDocker();
    const old = (await f.docker.getContainer(AGENT_ID).inspect()) as UpdateInspect;
    old.Name = '/homelab-agent-hz-old-x';
    old.State = { Running: false };
    await writeJournal(dataDir, journal({ phase: 'stopped' }));
    const r = await swapAgent(f.docker, env(), { log, wait: noWait });
    expect(f.calls).toEqual(['remove new', 'rename old homelab-agent', 'start old']);
    expect(r).toMatchObject({
      outcome: 'rolled_back',
      message: 'update interrupted; old container restored',
    });
    expect((await readJournal(dataDir, RUN))?.phase).toBe('done');
  });

  it('a helper restarted after the new agent started keeps it once healthy', async () => {
    const f = fakeDocker();
    await writeJournal(dataDir, journal({ phase: 'started' }));
    const r = await swapAgent(f.docker, env(), { log, wait: noWait });
    expect(f.calls).toEqual(['remove old']);
    expect(r).toMatchObject({ outcome: 'updated' });
  });

  it('a started but unhealthy new agent is rolled back on resume', async () => {
    const f = fakeDocker({ newHealth: 'unhealthy' });
    await writeJournal(dataDir, journal({ phase: 'started' }));
    const r = await swapAgent(f.docker, env(), { log, wait: noWait });
    expect(f.calls).toContain('remove new');
    expect(r).toMatchObject({ outcome: 'rolled_back' });
  });

  it('agent start: an interrupted core swap is undone before connecting', async () => {
    const s = service({ newHealth: 'unhealthy' });
    const core = (await s.docker.getContainer(CORE_ID).inspect()) as UpdateInspect;
    core.Name = '/homelab-zentrale-core-1-hz-old-x';
    core.State = { Running: false };
    await writeJournal(
      dataDir,
      journal({
        target: 'core',
        oldId: CORE_ID,
        oldName: 'homelab-zentrale-core-1',
        phase: 'started',
      }),
    );
    await s.svc.recoverAtStart();
    expect(s.calls).toEqual(['remove new', 'rename core homelab-zentrale-core-1', 'start core']);
    expect(await result()).toEqual([
      expect.objectContaining({ target: 'core', outcome: 'rolled_back' }),
    ]);
    expect(await readJournal(dataDir, RUN)).toBeNull();
  });

  it('a core update journals and removes the journal when done', async () => {
    const s = service();
    await s.svc.apply('core', RUN);
    await s.svc.lastRun;
    expect(await readJournal(dataDir, RUN)).toBeNull();
  });

  it('after welcome: exited helpers are removed, running ones and their journals stay', async () => {
    const s = service({
      helpers: [
        { Id: 'd'.repeat(64), State: 'exited', run: 'run_oldoldold' },
        { Id: 'h'.repeat(64).replace(/h/g, '9'), State: 'running', run: RUN },
      ],
    });
    await writeJournal(dataDir, journal());
    await s.svc.onReady();
    expect(s.calls).toEqual(['remove new']);
    expect(await readJournal(dataDir, RUN)).not.toBeNull();
  });

  it('after welcome in the NEW agent with the helper gone: old removed, updated', async () => {
    const s = service();
    // This process runs in AGENT_ID (mountinfo); the journal says AGENT_ID is the new one.
    await writeJournal(dataDir, journal({ oldId: OTHER, newId: AGENT_ID, phase: 'started' }));
    await s.svc.onReady();
    expect(s.calls).toEqual(['remove new']);
    expect(s.sent.map((m) => m.event)).toEqual([
      expect.objectContaining({ runId: RUN, outcome: 'updated' }),
    ]);
    expect(await readJournal(dataDir, RUN)).toBeNull();
  });

  it('after welcome in the OLD agent with the helper gone: new removed, name back, failed', async () => {
    const s = service();
    const own = (await s.docker.getContainer(AGENT_ID).inspect()) as UpdateInspect;
    own.Name = '/homelab-agent-hz-old-x';
    await writeJournal(dataDir, journal({ newId: OTHER }));
    await s.svc.onReady();
    expect(s.calls).toEqual(['remove new', 'rename old homelab-agent']);
    expect(s.sent.map((m) => m.event)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        message: 'update interrupted (updater gone); old agent kept',
      }),
    ]);
  });

  it('done journals are removed after welcome', async () => {
    const s = service();
    await writeJournal(dataDir, journal({ phase: 'done' }));
    await s.svc.onReady();
    expect(await readJournal(dataDir, RUN)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('result files are written with mode 0600', async () => {
    await writeResult(dataDir, {
      kind: 'update_result',
      runId: RUN,
      target: 'agent',
      outcome: 'updated',
    });
    const { stat } = await import('node:fs/promises');
    expect((await stat(path.join(dataDir, `update-result-${RUN}.json`))).mode & 0o777).toBe(0o600);
  });
});
