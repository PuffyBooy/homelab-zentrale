import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { certWriteDataSchema, rpcParamsByAction, type AgentEvent } from '@hz/shared';
import { Dispatcher } from '../src/actions/index.js';
import { certRemove, certWrite } from '../src/actions/certs.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let certs: string;
let outside: string;

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBcanary-cert\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEcanary-key\n-----END PRIVATE KEY-----\n';
const params = (name: string) => ({ name, fullchainPem: CERT, privkeyPem: KEY });

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-certs-')));
  root = path.join(base, 'homelab');
  certs = path.join(root, 'certs');
  outside = path.join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(certs, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'victim.pem'), 'precious');
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('cert.write', () => {
  it('writes fullchain 0644, privkey 0600 in a 0750 folder, no temp files left', async () => {
    const { ctx, rec } = makeCtx(root);
    const r = await certWrite(params('example-com'), ctx);
    expect(certWriteDataSchema.parse(r)).toEqual({ path: path.join(certs, 'example-com') });
    const dir = path.join(certs, 'example-com');
    expect(await mode(dir)).toBe(0o750);
    expect(await mode(path.join(dir, 'fullchain.pem'))).toBe(0o644);
    expect(await mode(path.join(dir, 'privkey.pem'))).toBe(0o600);
    expect(await readFile(path.join(dir, 'privkey.pem'), 'utf8')).toBe(KEY);
    expect((await readdir(dir)).sort()).toEqual(['fullchain.pem', 'privkey.pem']);
    // content never logged
    expect(rec.logs.join('\n')).not.toContain('canary');
  });

  it('overwrites an existing certificate and fixes the folder mode', async () => {
    const { ctx } = makeCtx(root);
    await mkdir(path.join(certs, 'renew'), { recursive: true, mode: 0o777 });
    await writeFile(path.join(certs, 'renew', 'privkey.pem'), 'old', { mode: 0o644 });
    await certWrite(params('renew'), ctx);
    expect(await mode(path.join(certs, 'renew'))).toBe(0o750);
    expect(await mode(path.join(certs, 'renew', 'privkey.pem'))).toBe(0o600);
    expect(await readFile(path.join(certs, 'renew', 'privkey.pem'), 'utf8')).toBe(KEY);
  });

  it.each(['fullchain.pem', 'privkey.pem'])(
    'refuses when %s is a symlink and never writes through it',
    async (file) => {
      const { ctx } = makeCtx(root);
      const dir = path.join(certs, 'linked');
      await mkdir(dir, { recursive: true });
      await symlink(path.join(outside, 'victim.pem'), path.join(dir, file));
      await expect(certWrite(params('linked'), ctx)).rejects.toMatchObject({ code: 'bad_path' });
      expect(await readFile(path.join(outside, 'victim.pem'), 'utf8')).toBe('precious');
      expect((await lstat(path.join(dir, file))).isSymbolicLink()).toBe(true);
    },
  );

  it('refuses a certificate folder that is a symlink', async () => {
    const { ctx } = makeCtx(root);
    await mkdir(certs, { recursive: true });
    await symlink(outside, path.join(certs, 'evil'));
    await expect(certWrite(params('evil'), ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).toEqual(['victim.pem']);
  });

  it('refuses a certs folder that is a symlink', async () => {
    const { ctx } = makeCtx(root);
    await symlink(outside, certs);
    await expect(certWrite(params('example-com'), ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(await readdir(outside)).toEqual(['victim.pem']);
    await rm(certs);
  });

  it('refuses when a target is a directory', async () => {
    const { ctx } = makeCtx(root);
    await mkdir(path.join(certs, 'dir', 'privkey.pem'), { recursive: true });
    await expect(certWrite(params('dir'), ctx)).rejects.toMatchObject({ code: 'bad_path' });
  });

  it.each(['../evil', '..', 'a/b', '/etc', 'Example', '-x', 'x-', '.hidden', 'a\0b', ''])(
    'the schema refuses the name %j',
    (name) => {
      expect(rpcParamsByAction['cert.write'].safeParse(params(name)).success).toBe(false);
      expect(rpcParamsByAction['cert.remove'].safeParse({ name }).success).toBe(false);
    },
  );

  it('the handler refuses a bad name even without the schema', async () => {
    const { ctx } = makeCtx(root);
    await expect(certWrite(params('../outside'), ctx)).rejects.toMatchObject({ code: 'bad_path' });
    await expect(certRemove({ name: '../outside' }, ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(await readdir(outside)).toEqual(['victim.pem']);
  });

  it('the dispatcher refuses PEM with garbage and does not echo the key', async () => {
    const { ctx } = makeCtx(root);
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const r = await d.handle({
      type: 'rpc',
      id: 'rpc_12345678',
      action: 'cert.write',
      params: { name: 'x1', fullchainPem: CERT, privkeyPem: 'canary-key-not-pem' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(JSON.stringify(r)).not.toContain('canary');
    expect(JSON.stringify(events)).not.toContain('canary');
  });
});

describe('cert.remove', () => {
  it('removes the folder; a missing folder is success', async () => {
    const { ctx } = makeCtx(root);
    await certWrite(params('gone'), ctx);
    await expect(certRemove({ name: 'gone' }, ctx)).resolves.toEqual({ removed: true });
    expect(await readdir(certs)).toEqual([]);
    await expect(certRemove({ name: 'gone' }, ctx)).resolves.toEqual({ removed: false });
    await rm(certs, { recursive: true });
    await expect(certRemove({ name: 'gone' }, ctx)).resolves.toEqual({ removed: false });
  });

  it('refuses a symlinked folder and a folder with a symlink inside; nothing deleted', async () => {
    const { ctx } = makeCtx(root);
    await mkdir(certs, { recursive: true });
    await symlink(outside, path.join(certs, 'evil'));
    await expect(certRemove({ name: 'evil' }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).toEqual(['victim.pem']);

    await certWrite(params('mixed'), ctx);
    await symlink(path.join(outside, 'victim.pem'), path.join(certs, 'mixed', 'chain.pem'));
    await expect(certRemove({ name: 'mixed' }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect((await readdir(path.join(certs, 'mixed'))).sort()).toEqual([
      'chain.pem',
      'fullchain.pem',
      'privkey.pem',
    ]);
    expect(await readFile(path.join(outside, 'victim.pem'), 'utf8')).toBe('precious');
  });
});
