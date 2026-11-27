import {
  defaultUpdatePolicy,
  type ImageVersion,
  type UpdateRun,
  type UpdateServerState,
  type UpdatesResponse,
} from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureApi, isApiError } from '../../lib/api.js';
import { setDisplayTimeZone } from '../../lib/format.js';
import { applyLiveMessage } from '../../lib/live.js';
import {
  CORE_HOST_UNKNOWN_HINT,
  durationText,
  fromToText,
  isoDaysText,
  parseStart,
  policySummary,
  saveUpdatePolicy,
  toggleIsoDay,
  updateNow,
  updateStatus,
  updatesKey,
  versionText,
} from '../../lib/updates.js';
import { UpdatesSettingsView } from '../settings/UpdatesSettingsTile.js';
import { AutoUpdateView, PolicyForm } from './AutoUpdateTile.js';

const NOW = new Date('2026-11-26T22:04:00.000Z');
const hex = (c: string): string => `sha256:${c.repeat(64)}`;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let reset: (() => void) | undefined;
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});
beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

const v = (over: Partial<ImageVersion>): ImageVersion => ({ imageId: hex('a'), ...over });

function state(over: Partial<UpdateServerState> = {}): UpdateServerState {
  return {
    serverId: 'srv-000001',
    name: 'heimserver',
    connected: true,
    hostsCore: true,
    policy: defaultUpdatePolicy,
    agent: {
      current: v({ version: 'sha-1a2b3c4' }),
      available: v({ imageId: hex('b'), version: 'sha-5d6e7f8' }),
      upToDate: false,
      checkedAt: '2026-11-26T22:00:00.000Z',
    },
    core: {
      current: v({ imageId: hex('c'), revision: '0123456789abcdef' }),
      available: v({ imageId: hex('d'), version: 'v1.3.0' }),
      upToDate: false,
      checkedAt: '2026-11-26T22:00:00.000Z',
    },
    os: { total: 12, security: 3 },
    rebootRequired: false,
    nextWindow: '2026-11-27T02:00:00.000Z',
    running: null,
    ...over,
  };
}

function run(over: Partial<UpdateRun> = {}): UpdateRun {
  return {
    id: 'run_abcdefgh',
    serverId: 'srv-000001',
    serverName: 'heimserver',
    target: 'agent',
    trigger: 'schedule',
    status: 'updated',
    startedAt: '2026-11-26T02:00:00.000Z',
    finishedAt: '2026-11-26T02:03:00.000Z',
    from: 'sha-1a2b3c4',
    to: 'sha-5d6e7f8',
    message: null,
    ...over,
  };
}

describe('Auto-Update tile', () => {
  it('versions of agent and core, one primary action, OS packages and the next window', () => {
    const out = html(
      <AutoUpdateView state={state()} last={run()} timeZone="Europe/Vienna" now={NOW} />,
    );
    expect(out).toContain('>Agent<');
    expect(out).toContain('sha-1a2b3c4');
    expect(out).toContain('Update auf sha-5d6e7f8');
    expect(out).toContain('>Zentrale<');
    // Core without version label: short revision.
    expect(out).toContain('0123456');
    expect(out).toContain('Update auf v1.3.0');
    expect(out.match(/hz-btn-primary/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Agent: jetzt aktualisieren" class="hz-btn hz-btn-primary');
    expect(out).toContain('aria-label="Zentrale: jetzt prüfen"');
    expect(out).toContain('12 Pakete offen, 3 Sicherheit');
    expect(out).toContain('Nächstes Fenster 27.11. 03:00');
    expect(out).toContain('Zeitzone Europe/Vienna');
    // Last run with shape and text.
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('aktualisiert');
    expect(out).toContain('sha-1a2b3c4 → sha-5d6e7f8');
  });

  it('a disk problem (Aufräumen primary) keeps "Jetzt aktualisieren" secondary', () => {
    const out = html(
      <AutoUpdateView
        state={state()}
        last={undefined}
        timeZone={undefined}
        now={NOW}
        primaryAllowed={false}
      />,
    );
    expect(out).not.toContain('hz-btn-primary');
    expect(out).toContain('aria-label="Agent: jetzt aktualisieren" class="hz-btn hz-btn-secondary');
  });

  it('Zentrale only on the core host; nothing primary without an update', () => {
    const s = state({
      hostsCore: false,
      core: null,
      agent: { ...state().agent, available: null, upToDate: true },
    });
    const out = html(<AutoUpdateView state={s} last={undefined} timeZone={undefined} now={NOW} />);
    expect(out).not.toContain('>Zentrale<');
    expect(out).not.toContain('aria-label="Zentrale');
    expect(out).not.toContain('hz-btn-primary');
    expect(out).toContain('Noch kein Update-Lauf.');
  });

  it('running: busy with text, buttons off; rolled back shows WARN', () => {
    const out = html(
      <AutoUpdateView
        state={state({ running: 'agent' })}
        last={run({ status: 'rolled_back', message: 'health check failed' })}
        timeZone={undefined}
        now={NOW}
      />,
    );
    expect(out).toContain('hz-status-busy');
    expect(out).toContain('Agent läuft');
    expect(out).toContain('wird aktualisiert …');
    expect(out).toMatch(/disabled=""[^>]*aria-label="Agent: jetzt aktualisieren"/);
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('zurückgerollt');
    expect(out).toContain('health check failed');
  });

  it('policy form: Agent, Zentrale, OS, Neustart, Mo–So, Start, Dauer', () => {
    const out = html(<PolicyForm state={state()} />);
    for (const t of ['Agent', 'Zentrale', 'OS-Pakete', 'Neustart bei Bedarf']) {
      expect(out).toContain(`aria-label="${t}"`);
    }
    expect(out).toContain('Einschalten braucht einen Code.');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(7);
    expect(out).toContain('value="03:00"');
    expect(out).toContain('>2 h<');
    expect(html(<PolicyForm state={state({ hostsCore: false })} />)).not.toContain(
      'aria-label="Zentrale"',
    );
  });

  it('saving a policy that turns reboot on goes through step-up and repeats', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const next = state({ policy: { ...defaultUpdatePolicy, reboot: true } });
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(403, { ok: false, error: 'step_up_required' }))
      .mockResolvedValueOnce(reply(200, next));
    vi.stubGlobal('fetch', f);
    const res = await saveUpdatePolicy('srv-000001', next.policy);
    expect(res.policy.reboot).toBe(true);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[1]?.[0]).toBe('/api/servers/srv-000001/update-policy');
    expect(f.mock.calls[1]?.[1]?.method).toBe('PUT');
  });

  it('cancelled step-up keeps the old policy (request rejected)', async () => {
    reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(reply(403, { ok: false, error: 'step_up_required' })),
    );
    const err = await saveUpdatePolicy('srv-000001', defaultUpdatePolicy).catch((e: unknown) => e);
    expect(isApiError(err, 'step_up_required')).toBe(true);
  });

  it('"Jetzt aktualisieren" posts the target', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(reply(200, { runId: 'run_abcdefgh' }));
    vi.stubGlobal('fetch', f);
    await expect(updateNow('srv-000001', 'agent')).resolves.toEqual({ runId: 'run_abcdefgh' });
    expect(f.mock.calls[0]?.[0]).toBe('/api/servers/srv-000001/update');
    expect(f.mock.calls[0]?.[1]?.body).toBe('{"target":"agent"}');
  });
});

describe('Settings → Updates', () => {
  const data: UpdatesResponse = {
    servers: [state(), state({ serverId: 'srv-000002', name: 'pi', hostsCore: false, core: null })],
    runs: [
      run({ status: 'rolled_back', serverId: 'srv-000002', serverName: 'pi', message: 'kaputt' }),
      run(),
    ],
    coreHostKnown: false,
  };

  it('all servers with versions and policy, run history, hint without a core host', () => {
    const out = html(<UpdatesSettingsView data={data} now={NOW} />);
    expect(out).toContain(CORE_HOST_UNKNOWN_HINT);
    expect(out).toContain('sudo ./deploy/install.sh update');
    expect(out).toContain('heimserver');
    expect(out).toContain('Agent sha-1a2b3c4 · Zentrale 0123456');
    expect(out).toContain('Agent, Zentrale · täglich 03:00 für 2 h');
    expect(out).toContain('href="/servers/srv-000001#updates"');
    expect(out).toContain('aria-label="Update-Verlauf"');
    expect(out).toContain('Verlauf · letzte 2');
    expect(out).toContain('kaputt');
    expect(out).toContain('zurückgerollt');
    expect(out).toContain('hz-status-warn');
  });

  it('no hint when the core host is known', () => {
    const out = html(<UpdatesSettingsView data={{ ...data, coreHostKnown: true }} now={NOW} />);
    expect(out).not.toContain('install.sh update');
  });
});

describe('update helpers', () => {
  it('version text: version, else short revision, else short image id', () => {
    expect(versionText(v({ version: 'v1.2.0', revision: 'abcdef1234' }))).toBe('v1.2.0');
    expect(versionText(v({ revision: 'abcdef1234' }))).toBe('abcdef1');
    expect(versionText(v({}))).toBe('aaaaaaaaaaaa');
    expect(versionText(null)).toBe('—');
  });

  it('days, durations, start and summary', () => {
    expect(isoDaysText([1, 2, 3, 4, 5])).toBe('Mo–Fr');
    expect(isoDaysText([6, 7])).toBe('Sa, So');
    expect(isoDaysText([1, 3, 4, 5])).toBe('Mo, Mi–Fr');
    expect(toggleIsoDay([3, 1], 2)).toEqual([1, 2, 3]);
    expect(durationText(90)).toBe('1,5 h');
    expect(durationText(30)).toBe('30 Min');
    expect(parseStart('3:00')).toBe('03:00');
    expect(parseStart('25:00')).toBeNull();
    expect(policySummary({ ...defaultUpdatePolicy, agent: false, core: false }, true)).toBe('aus');
    expect(policySummary(defaultUpdatePolicy, false)).toBe('Agent · täglich 03:00 für 2 h');
    expect(fromToText({ from: 'a', to: 'a' })).toBe('a');
  });

  it('status per server', () => {
    expect(updateStatus(state(), undefined).status).toBe('info');
    expect(updateStatus(state({ running: 'core' }), undefined)).toEqual({
      status: 'busy',
      label: 'Zentrale läuft',
    });
    expect(updateStatus(state(), run({ status: 'failed' })).status).toBe('crit');
    expect(updateStatus(state({ connected: false }), run()).status).toBe('off');
  });

  it('live topic updates replaces the cached response, invalid ones refetch', () => {
    const qc = new QueryClient();
    const data: UpdatesResponse = { servers: [state()], runs: [], coreHostKnown: true };
    applyLiveMessage(qc, { type: 'snapshot', topic: 'updates', data });
    expect(qc.getQueryData(updatesKey)).toEqual(data);
    const next = { ...data, coreHostKnown: false };
    applyLiveMessage(qc, { type: 'update', topic: 'updates', upsert: [next] });
    expect(qc.getQueryData<UpdatesResponse>(updatesKey)?.coreHostKnown).toBe(false);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyLiveMessage(qc, { type: 'update', topic: 'updates', upsert: [{ bad: true }] });
    expect(spy).toHaveBeenCalled();
    expect(qc.getQueryData<UpdatesResponse>(updatesKey)?.coreHostKnown).toBe(false);
  });
});
