import { afterEach, describe, expect, it } from 'vitest';
import {
  appPreviewResponseSchema,
  appsResponseSchema,
  appTemplateDetailSchema,
  appTemplatesResponseSchema,
  installedAppSchema,
} from '@hz/shared';
import { withStepUp, type WsClient } from './agent-helpers.js';
import {
  appRequest,
  customTemplate,
  installBody,
  rpcsOf,
  SAFE_CUSTOM_COMPOSE,
  withApps,
  type AppsSetup,
} from './apps-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withApps>[1] = {}): Promise<AppsSetup> {
  const s = await withApps(clients, opts);
  t = s.t;
  return s;
}

async function install(s: AppsSetup, over: Record<string, unknown> = {}) {
  const res = await appRequest(s, 'POST', '/api/apps', installBody(s, over));
  if (res.statusCode !== 202) throw new Error(`install ${res.statusCode} ${res.body}`);
  const app = installedAppSchema.parse(res.json());
  await s.idle();
  return app;
}

const getApp = async (s: AppsSetup, id: string) => {
  const res = await appRequest(s, 'GET', '/api/apps');
  return appsResponseSchema.parse(res.json()).apps.find((a) => a.id === id);
};

describe('M21 acceptance: vaultwarden on a sim server', () => {
  it('installs, runs, updates and removes vaultwarden', async () => {
    const s = await setup();
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    expect(res.statusCode).toBe(202);
    const created = installedAppSchema.parse(res.json());
    expect(created.status).toBe('installing');
    await s.idle();

    // compose.write: compose.yml with the label, .env with all values; then compose.up.
    const [write] = rpcsOf(s, 'compose.write');
    const params = write?.params as { dir: string; files: Record<string, string> };
    expect(params.dir).toBe('/opt/homelab/apps/vault');
    expect(Object.keys(params.files).sort()).toEqual(['.env', 'compose.yml']);
    expect(params.files['compose.yml']).toContain('homelab.app: vault');
    expect(params.files['compose.yml']).toContain('${BIND}:${WEB_PORT}:80');
    const env = params.files['.env'] ?? '';
    expect(env).toContain("APP_ID='vault'");
    expect(env).toContain("BIND='100.64.0.5'");
    expect(env).toContain("TZ='Europe/Vienna'");
    expect(env).toMatch(/^ADMIN_TOKEN='[A-Za-z0-9_-]{24}'$/m);
    expect(rpcsOf(s, 'compose.up').map((r) => (r.params as { dir: string }).dir)).toEqual([
      '/opt/homelab/apps/vault',
    ]);
    const order = s.rpcs.map((r) => r.action);
    expect(order.indexOf('compose.write')).toBeLessThan(order.indexOf('compose.up'));

    const running = await getApp(s, created.id);
    expect(running).toMatchObject({
      status: 'running',
      appId: 'vault',
      serverName: 'heimserver',
      bind: 'tailnet',
      url: 'http://100.64.0.5:8222',
      ports: [{ port: 8222, protocol: 'tcp', label: 'Web-Port' }],
      params: { WEB_PORT: 8222, SIGNUPS_ALLOWED: false, DOMAIN: '' },
      hasSecrets: true,
      lastError: null,
    });
    expect(running?.containers).toEqual([{ name: 'vault', state: 'running', health: 'healthy' }]);

    // The catalog counts the installation.
    const cat = appTemplatesResponseSchema.parse(
      (await appRequest(s, 'GET', '/api/apps/templates')).json(),
    );
    expect(cat.templates.find((x) => x.id === 'vaultwarden')?.installed).toBe(1);

    // Update: compose.write (re-rendered, same password), compose.pull, compose.up.
    const before = s.rpcs.length;
    const upd = await appRequest(s, 'POST', `/api/apps/${created.id}/update`);
    expect(upd.statusCode).toBe(202);
    expect(installedAppSchema.parse(upd.json()).status).toBe('updating');
    await s.idle();
    expect(s.rpcs.slice(before).map((r) => r.action)).toEqual([
      'compose.write',
      'compose.pull',
      'compose.up',
    ]);
    const env2 = (s.rpcs[before]?.params as { files: Record<string, string> }).files['.env'];
    const token = (x: string | undefined) => /^ADMIN_TOKEN='(.*)'$/m.exec(x ?? '')?.[1];
    expect(token(env2)).toBe(token(env));
    expect((await getApp(s, created.id))?.status).toBe('running');

    // Stop / start / restart.
    expect((await appRequest(s, 'POST', `/api/apps/${created.id}/stop`)).statusCode).toBe(202);
    await s.idle();
    expect((await getApp(s, created.id))?.status).toBe('stopped');
    expect(rpcsOf(s, 'compose.down').length).toBe(1);
    expect((await appRequest(s, 'POST', `/api/apps/${created.id}/start`)).statusCode).toBe(202);
    await s.idle();
    expect((await getApp(s, created.id))?.status).toBe('running');
    expect((await appRequest(s, 'POST', `/api/apps/${created.id}/restart`)).statusCode).toBe(202);
    await s.idle();
    expect(rpcsOf(s, 'compose.down').length).toBe(2);
    expect((await getApp(s, created.id))?.status).toBe('running');

    // Remove with step-up and the app name.
    const rm = await withStepUp(s.t, () =>
      appRequest(s, 'DELETE', `/api/apps/${created.id}`, {
        confirmName: 'vault',
        deleteData: true,
      }),
    );
    expect(rm.statusCode).toBe(202);
    await s.idle();
    expect(rpcsOf(s, 'app.remove').map((r) => r.params)).toEqual([
      { appId: 'vault', deleteData: true },
    ]);
    expect(await getApp(s, created.id)).toBeUndefined();

    const audit = s.t.db.sqlite
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'app.%' ORDER BY id")
      .all() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual([
      'app.installed',
      'app.updated',
      'app.stop',
      'app.start',
      'app.restart',
      'app.removed',
    ]);
  });

  it('a custom template with privileged: true is refused', async () => {
    const s = await setup();
    const evil = SAFE_CUSTOM_COMPOSE.replace(
      'image: nginx:1.27',
      'image: nginx:1.27\n    privileged: true',
    );
    const res = await appRequest(s, 'POST', '/api/apps/templates', customTemplate(evil));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(res.json<{ message: string }>().message).toContain('privileged');
    expect(s.t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM app_templates').get()).toEqual({
      n: 0,
    });
  });

  it('a used port prevents the installation', async () => {
    const s = await setup();
    s.behaviour.listening.push({ proto: 'tcp', address: '0.0.0.0', port: 8222 });
    await s.sendInventory();
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'conflict',
      message: 'Port 8222/tcp ist auf dem Server belegt',
    });
    expect(rpcsOf(s, 'compose.write')).toEqual([]);
    // Another port works.
    const ok = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { params: { WEB_PORT: 8223 } }),
    );
    expect(ok.statusCode).toBe(202);
    await s.idle();
    // The app's own port is now taken for a second app.
    const second = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { appId: 'vault2', params: { WEB_PORT: 8223 } }),
    );
    expect(second.statusCode).toBe(409);
  });
});

describe('install checks', () => {
  it('appId unique per server, architecture, RAM reserve, Tailscale IP', async () => {
    const s = await setup();
    await install(s);
    const dup = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { params: { WEB_PORT: 8300 } }),
    );
    expect(dup.statusCode).toBe(409);

    const arm = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { templateId: 'armonly', appId: 'arm' }),
    );
    expect(arm.statusCode).toBe(400);
    expect(arm.json<{ message: string }>().message).toBe('Läuft nicht auf amd64');

    const big = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { templateId: 'bigram', appId: 'big' }),
    );
    expect(big.statusCode).toBe(409);
    expect(big.json()).toMatchObject({ error: 'insufficient_ram' });
    expect(big.json<{ details: { neededBytes: number } }>().details.neededBytes).toBe(
      20000 * 1024 * 1024,
    );
  });

  it('bind tailnet without a known Tailscale IP fails; localhost works; all adds allowed ports', async () => {
    const s = await setup({ noTailscaleIp: true });
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toBe('Tailscale-IP unbekannt');

    const local = await install(s, { bind: 'localhost' });
    const env = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> }).files[
      '.env'
    ];
    expect(env).toContain("BIND='127.0.0.1'");
    expect(local.url).toBeNull();

    const all = await install(s, { bind: 'all', appId: 'vault-lan', params: { WEB_PORT: 8400 } });
    const env2 = (rpcsOf(s, 'compose.write')[1]?.params as { files: Record<string, string> }).files[
      '.env'
    ];
    expect(env2).toContain("BIND='0.0.0.0'");
    const allowed = await appRequest(s, 'GET', `/api/servers/${s.serverId}/ports/allowed`);
    expect(allowed.json<{ allowed: { port: number; note?: string }[] }>().allowed).toContainEqual(
      expect.objectContaining({ port: 8400, proto: 'tcp' }),
    );
    // Removing releases the allowed entry.
    await withStepUp(s.t, () =>
      appRequest(s, 'DELETE', `/api/apps/${all.id}`, { confirmName: 'vault-lan' }),
    );
    await s.idle();
    const after = await appRequest(s, 'GET', `/api/servers/${s.serverId}/ports/allowed`);
    expect(after.json<{ allowed: { port: number }[] }>().allowed.map((p) => p.port)).not.toContain(
      8400,
    );
  });

  it('agent errors set status error with a German reason; agent offline is 409', async () => {
    const s = await setup();
    s.behaviour.fail['compose.up'] = { code: 'failed', message: 'pull access denied' };
    const app = await install(s);
    const row = await getApp(s, app.id);
    expect(row?.status).toBe('error');
    expect(row?.lastError).toContain('Container starten fehlgeschlagen');
    s.agent.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    const off = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { appId: 'bb', params: { WEB_PORT: 8500 } }),
    );
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ error: 'agent_offline' });
  });

  it('invalid input: unknown template/server, bad params, mismatching preview id', async () => {
    const s = await setup();
    expect(
      (await appRequest(s, 'POST', '/api/apps', installBody(s, { templateId: 'nope' }))).statusCode,
    ).toBe(404);
    expect(
      (
        await appRequest(
          s,
          'POST',
          '/api/apps',
          installBody(s, { serverId: 'AAAAAAAAAAAAAAAAAAAAAA' }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await appRequest(s, 'POST', '/api/apps', installBody(s, { appId: '../x' }))).statusCode,
    ).toBe(400);
    expect(
      (await appRequest(s, 'POST', '/api/apps', installBody(s, { params: { WEB_PORT: 80 } })))
        .statusCode,
    ).toBe(400);
    expect(
      (await appRequest(s, 'POST', '/api/apps', { ...installBody(s), extra: 1 })).statusCode,
    ).toBe(400);
    expect(
      (await appRequest(s, 'POST', '/api/apps/templates/armonly/preview', installBody(s)))
        .statusCode,
    ).toBe(400);
    expect((await appRequest(s, 'POST', '/api/apps/AAAAAAAAAAAA/start')).statusCode).toBe(404);
    expect((await appRequest(s, 'POST', '/api/apps/AAAAAAAAAAAA/explode')).statusCode).toBe(400);
  });
});

describe('preview', () => {
  it('renders compose and env with masked passwords and lists problems', async () => {
    const s = await setup();
    const res = await appRequest(
      s,
      'POST',
      '/api/apps/templates/vaultwarden/preview',
      installBody(s),
    );
    expect(res.statusCode).toBe(200);
    const p = appPreviewResponseSchema.parse(res.json());
    expect(p.problems).toEqual([]);
    expect(p.compose).toContain('homelab.app: vault');
    expect(p.env).toContain("ADMIN_TOKEN='••••••'");
    expect(p.env).not.toMatch(/ADMIN_TOKEN='[A-Za-z0-9_-]{24}'/);

    s.behaviour.listening.push({ proto: 'tcp', address: '0.0.0.0', port: 8222 });
    await s.sendInventory();
    const bad = appPreviewResponseSchema.parse(
      (
        await appRequest(
          s,
          'POST',
          '/api/apps/templates/vaultwarden/preview',
          installBody(s, { params: { DOMAIN: 'ftp://x' } }),
        )
      ).json(),
    );
    expect(bad.problems).toEqual([
      '„Adresse“: Format passt nicht',
      'Port 8222/tcp ist auf dem Server belegt',
    ]);
    expect(bad.env).toBe('');
  });
});

describe('custom templates', () => {
  it('create, read, update, install, delete (409 in use), builtin protected', async () => {
    const s = await setup();
    const body = customTemplate(SAFE_CUSTOM_COMPOSE);
    const created = await appRequest(s, 'POST', '/api/apps/templates', body);
    expect(created.statusCode).toBe(201);
    expect(appTemplateDetailSchema.parse(created.json())).toMatchObject({
      source: 'custom',
      meta: { id: 'meine-app' },
    });
    expect((await appRequest(s, 'POST', '/api/apps/templates', body)).statusCode).toBe(409);
    const clash = await appRequest(
      s,
      'POST',
      '/api/apps/templates',
      customTemplate(SAFE_CUSTOM_COMPOSE, { id: 'vaultwarden' }),
    );
    expect(clash.statusCode).toBe(409);

    const list = appTemplatesResponseSchema.parse(
      (await appRequest(s, 'GET', '/api/apps/templates')).json(),
    );
    expect(list.templates.map((x) => `${x.source}:${x.id}`).sort()).toEqual([
      'builtin:armonly',
      'builtin:bigram',
      'builtin:vaultwarden',
      'custom:meine-app',
    ]);

    const upd = await appRequest(
      s,
      'PUT',
      '/api/apps/templates/meine-app',
      customTemplate(SAFE_CUSTOM_COMPOSE, { name: 'Meine App 2', version: '1.1' }),
    );
    expect(upd.statusCode).toBe(200);
    expect(appTemplateDetailSchema.parse(upd.json()).meta.name).toBe('Meine App 2');
    const evil = await appRequest(
      s,
      'PUT',
      '/api/apps/templates/meine-app',
      customTemplate(SAFE_CUSTOM_COMPOSE.replace('./data/html', '/etc')),
    );
    expect(evil.statusCode).toBe(400);
    expect(
      (
        await appRequest(
          s,
          'PUT',
          '/api/apps/templates/meine-app',
          customTemplate(SAFE_CUSTOM_COMPOSE, { id: 'x1' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await appRequest(
          s,
          'PUT',
          '/api/apps/templates/vaultwarden',
          customTemplate(SAFE_CUSTOM_COMPOSE, { id: 'vaultwarden' }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await appRequest(
          s,
          'PUT',
          '/api/apps/templates/nope',
          customTemplate(SAFE_CUSTOM_COMPOSE, { id: 'nope' }),
        )
      ).statusCode,
    ).toBe(404);

    const app = await install(s, { templateId: 'meine-app', appId: 'web' });
    expect(app.source).toBe('custom');
    expect((await getApp(s, app.id))?.status).toBe('running');

    const inUse = await appRequest(s, 'DELETE', '/api/apps/templates/meine-app');
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json<{ message: string }>().message).toContain('verwendet');
    expect((await appRequest(s, 'DELETE', '/api/apps/templates/vaultwarden')).statusCode).toBe(403);

    await withStepUp(s.t, () =>
      appRequest(s, 'DELETE', `/api/apps/${app.id}`, { confirmName: 'web' }),
    );
    await s.idle();
    expect((await appRequest(s, 'DELETE', '/api/apps/templates/meine-app')).statusCode).toBe(204);
    expect((await appRequest(s, 'DELETE', '/api/apps/templates/meine-app')).statusCode).toBe(404);
    expect((await appRequest(s, 'GET', '/api/apps/templates/meine-app')).statusCode).toBe(404);
  });

  it('refuses invalid metadata and unknown placeholders', async () => {
    const s = await setup();
    const reserved = customTemplate(SAFE_CUSTOM_COMPOSE, {
      params: [{ type: 'string', key: 'BIND', label: 'x', default: '0.0.0.0' }],
    });
    expect((await appRequest(s, 'POST', '/api/apps/templates', reserved)).statusCode).toBe(400);
    const unknown = customTemplate(
      `${SAFE_CUSTOM_COMPOSE}    environment:\n      T: \${HZ_AGENT_TOKEN}\n`,
    );
    const res = await appRequest(s, 'POST', '/api/apps/templates', unknown);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('Unbekannter Platzhalter');
    const badDefault = customTemplate(SAFE_CUSTOM_COMPOSE, {
      params: [
        { type: 'port', key: 'WEB_PORT', label: 'Web', default: 9300 },
        { type: 'number', key: 'N', label: 'N', default: 50, min: 1, max: 10 },
      ],
    });
    expect((await appRequest(s, 'POST', '/api/apps/templates', badDefault)).statusCode).toBe(400);
  });
});
