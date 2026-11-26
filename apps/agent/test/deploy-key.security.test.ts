import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  chmod,
  link,
  unlink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, RpcEnvelope } from '@hz/shared';
import { Dispatcher, type ActionContext } from '../src/actions/index.js';
import {
  armor,
  PEM_BEGIN,
  PEM_END,
  decodeOpenSshPublicKey,
  encodeOpenSshPrivateKey,
  ensureDeployKey,
  existingKeyPath,
  generateEd25519,
  publicBlob,
} from '../src/actions/deploy-key.js';
import { KNOWN_HOSTS_FILE } from '../src/actions/deploy.js';
import type { RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-dkey-')));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let n = 0;
async function freshDataDir(): Promise<string> {
  const d = path.join(base, `data${n++}`);
  await mkdir(d, { mode: 0o700 });
  return d;
}

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

describe('OpenSSH key format', () => {
  it('round-trips and the private key signs for the public key', () => {
    const { seed, pub } = generateEd25519();
    const text = encodeOpenSshPrivateKey(seed, pub, 'homelab-zentrale test');
    expect(text.startsWith(`${PEM_BEGIN}\n`)).toBe(true);
    expect(text.split('\n').every((l) => l.length <= 70)).toBe(true);
    expect(decodeOpenSshPublicKey(text).equals(pub)).toBe(true);
    // Node itself agrees that seed and public key belong together.
    const priv = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: seed.toString('base64url'),
        x: pub.toString('base64url'),
      },
      format: 'jwk',
    });
    const pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') },
      format: 'jwk',
    });
    const sig = sign(null, Buffer.from('m'), priv);
    expect(verify(null, Buffer.from('m'), pubKey, sig)).toBe(true);
  });

  it('rejects tampered or foreign key files', () => {
    const { seed, pub } = generateEd25519();
    const good = encodeOpenSshPrivateKey(seed, pub, 'c');
    expect(() => decodeOpenSshPublicKey('')).toThrow();
    const rsa = armor('AAAA').replaceAll('OPENSSH', 'RSA');
    expect(() => decodeOpenSshPublicKey(rsa)).toThrow();
    // Flip one byte inside the private section: the embedded public key no longer matches.
    const b64 = good.split('\n').slice(1, -2).join('');
    const raw = Buffer.from(b64, 'base64');
    raw[raw.length - 40] = (raw[raw.length - 40] ?? 0) ^ 0xff;
    expect(() => decodeOpenSshPublicKey(armor(raw.toString('base64')))).toThrow();
    // Truncated key.
    expect(() => decodeOpenSshPublicKey(armor(raw.subarray(0, 120).toString('base64')))).toThrow();
    // Not base64 inside the armor.
    expect(() => decodeOpenSshPublicKey(armor('AAAA$(id)'))).toThrow();
  });

  it.skipIf(!hasSshKeygen())(
    'ssh-keygen reads the key and derives the same public key',
    async () => {
      const dataDir = await freshDataDir();
      const line = await ensureDeployKey(dataDir, 'kg');
      const out = execFileSync(
        'ssh-keygen',
        ['-y', '-f', path.join(dataDir, 'deploy-keys', 'kg')],
        {
          encoding: 'utf8',
        },
      );
      expect(out.trim().split(' ').slice(0, 2)).toEqual(line.split(' ').slice(0, 2));
    },
  );
});

describe('deploy.key files', () => {
  it('creates dir 0700 and key 0600, returns one public key line, is idempotent', async () => {
    const dataDir = await freshDataDir();
    const line = await ensureDeployKey(dataDir, 'my-repo');
    expect(line).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ homelab-zentrale my-repo$/,
    );
    const dir = path.join(dataDir, 'deploy-keys');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const keyFile = path.join(dir, 'my-repo');
    const st = await lstat(keyFile);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    // No temp files left, no .pub needed.
    expect(await readdir(dir)).toEqual(['my-repo']);
    expect(await ensureDeployKey(dataDir, 'my-repo')).toBe(line);
    expect(await ensureDeployKey(dataDir, 'other')).not.toBe(line);
    expect(await existingKeyPath(dataDir, 'my-repo')).toBe(keyFile);
  });

  it('parallel calls end with one key', async () => {
    const dataDir = await freshDataDir();
    const lines = await Promise.all([1, 2, 3, 4].map(() => ensureDeployKey(dataDir, 'race')));
    expect(new Set(lines).size).toBe(1);
    expect(await readdir(path.join(dataDir, 'deploy-keys'))).toEqual(['race']);
  });

  it('waits for a parallel call that still holds its temp link', async () => {
    const dataDir = await freshDataDir();
    const line = await ensureDeployKey(dataDir, 'linked');
    const keyFile = path.join(dataDir, 'deploy-keys', 'linked');
    const tmp = path.join(dataDir, 'deploy-keys', `.tmp-${'01234567'}${'89abcdef'}`);
    await link(keyFile, tmp);
    setTimeout(() => void unlink(tmp), 60);
    expect(await ensureDeployKey(dataDir, 'linked')).toBe(line);
  });

  it('tightens a too wide mode back to 0600', async () => {
    const dataDir = await freshDataDir();
    const line = await ensureDeployKey(dataDir, 'wide');
    const keyFile = path.join(dataDir, 'deploy-keys', 'wide');
    await chmod(keyFile, 0o644);
    await chmod(path.join(dataDir, 'deploy-keys'), 0o755);
    expect(await ensureDeployKey(dataDir, 'wide')).toBe(line);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dataDir, 'deploy-keys'))).mode & 0o777).toBe(0o700);
  });

  it('never follows a symlink at the key path (existing or dangling)', async () => {
    const dataDir = await freshDataDir();
    await mkdir(path.join(dataDir, 'deploy-keys'), { mode: 0o700 });
    const target = path.join(base, `victim${n}`);
    await writeFile(target, 'do not touch\n');
    await symlink(target, path.join(dataDir, 'deploy-keys', 'evil'));
    await expect(ensureDeployKey(dataDir, 'evil')).rejects.toMatchObject({ code: 'failed' });
    expect(await readFile(target, 'utf8')).toBe('do not touch\n');

    const missing = path.join(base, `missing${n}`);
    await symlink(missing, path.join(dataDir, 'deploy-keys', 'dangling'));
    await expect(ensureDeployKey(dataDir, 'dangling')).rejects.toMatchObject({ code: 'failed' });
    await expect(lstat(missing)).rejects.toThrow();
    await expect(existingKeyPath(dataDir, 'evil')).rejects.toMatchObject({ code: 'failed' });
  });

  it('refuses a symlinked key directory and hard-linked keys', async () => {
    const dataDir = await freshDataDir();
    const elsewhere = path.join(base, `elsewhere${n}`);
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(dataDir, 'deploy-keys'));
    await expect(ensureDeployKey(dataDir, 'k')).rejects.toMatchObject({ code: 'failed' });
    expect(await readdir(elsewhere)).toEqual([]);

    const d2 = await freshDataDir();
    await ensureDeployKey(d2, 'k');
    await link(path.join(d2, 'deploy-keys', 'k'), path.join(base, `hardlink${n}`));
    await expect(ensureDeployKey(d2, 'k')).rejects.toMatchObject({ code: 'failed' });
  });

  it('existingKeyPath reports a missing key as not_found and does not create one', async () => {
    const dataDir = await freshDataDir();
    await expect(existingKeyPath(dataDir, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(await readdir(path.join(dataDir, 'deploy-keys'))).toEqual([]);
  });
});

describe('deploy.key over the dispatcher', () => {
  function setup(dataDir: string) {
    const logLines: string[] = [];
    const events: AgentEvent[] = [];
    const ctx: ActionContext = {
      name: 'heimserver',
      allowTerminal: false,
      homelabRoot: `${base}/`,
      host: {
        hostProc: '/proc',
        hostRoot: '/nonexistent',
        docker: null,
        exec: async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' }),
      },
      log: createLogger('debug', (l) => logLines.push(l)),
      later: () => undefined,
      streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
      run: async (): Promise<RunResult> => {
        throw new Error('no programs for deploy.key');
      },
      dockerSocket: '/var/run/docker.sock',
      spawn: () => {
        throw new Error('no programs for deploy.key');
      },
      dataDir,
    };
    return { d: new Dispatcher(ctx, (e) => events.push(e)), logLines, events };
  }
  const rpc = (params: unknown): RpcEnvelope => ({
    type: 'rpc',
    id: 'rpc_dkey0001',
    action: 'deploy.key',
    params,
  });

  it('returns only { publicKey }; the private key is in no result, log or event', async () => {
    const dataDir = await freshDataDir();
    const { d, logLines, events } = setup(dataDir);
    const res = await d.handle(rpc({ name: 'site' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.data as object)).toEqual(['publicKey']);
    const privText = await readFile(path.join(dataDir, 'deploy-keys', 'site'), 'utf8');
    const body = privText.split('\n').slice(1, -2);
    const everything = JSON.stringify([res, logLines, events]);
    for (const line of body) expect(everything).not.toContain(line);
    expect(everything).not.toContain(PEM_BEGIN);
    expect(everything).not.toContain(PEM_END);
  });

  it.each(['../x', '.hidden', 'a/b', '', '-rf', 'x'.repeat(101), 'a..b'])(
    'rejects key name %j',
    async (name) => {
      const dataDir = await freshDataDir();
      const { d } = setup(dataDir);
      const res = await d.handle(rpc({ name }));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
      await expect(lstat(path.join(dataDir, 'deploy-keys'))).rejects.toThrow();
    },
  );
});

describe('bundled GitHub host keys', () => {
  it('match the fingerprints GitHub publishes', async () => {
    const text = await readFile(KNOWN_HOSTS_FILE, 'utf8');
    const fps = Object.fromEntries(
      text
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const [host, type, key] = l.split(' ');
          expect(host).toBe('github.com');
          const fp = createHash('sha256')
            .update(Buffer.from(key ?? '', 'base64'))
            .digest('base64');
          return [type, fp.replace(/=+$/, '')];
        }),
    );
    expect(fps).toEqual({
      'ssh-ed25519': '+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
      'ecdsa-sha2-nistp256': 'p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
      'ssh-rsa': 'uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
    });
  });

  it('publicBlob has the ssh-ed25519 wire format', () => {
    const blob = publicBlob(Buffer.alloc(32, 1));
    expect(blob.readUInt32BE(0)).toBe(11);
    expect(blob.subarray(4, 15).toString()).toBe('ssh-ed25519');
    expect(blob.readUInt32BE(15)).toBe(32);
  });
});
