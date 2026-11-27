import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { appSecretsResponseSchema, installedAppSchema } from '@hz/shared';
import { stepUp, withStepUp, type WsClient } from './agent-helpers.js';
import {
  appRequest,
  customTemplate,
  installBody,
  rpcsOf,
  SAFE_CUSTOM_COMPOSE,
  withApps,
  type AppsSetup,
} from './apps-helpers.js';
import { completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

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

/** Fake secret generated at runtime (no secret-looking literals in the repo). */
const fakeSecret = (): string => `pw-${randomBytes(12).toString('hex')}`;

const ID = 'AAAAAAAAAAAA';
const ROUTES: [string, string][] = [
  ['GET', '/api/apps/templates'],
  ['GET', '/api/apps/templates/vaultwarden'],
  ['POST', '/api/apps/templates'],
  ['PUT', '/api/apps/templates/vaultwarden'],
  ['DELETE', '/api/apps/templates/vaultwarden'],
  ['POST', '/api/apps/templates/vaultwarden/preview'],
  ['GET', '/api/apps'],
  ['POST', '/api/apps'],
  ['POST', `/api/apps/${ID}/start`],
  ['POST', `/api/apps/${ID}/stop`],
  ['POST', `/api/apps/${ID}/restart`],
  ['POST', `/api/apps/${ID}/update`],
  ['GET', `/api/apps/${ID}/secrets`],
  ['DELETE', `/api/apps/${ID}`],
];

describe('apps: access', () => {
  it.each(ROUTES)('%s %s is 401 without a session', async (method, url) => {
    t = await makeApp({ modules: { apps: true } });
    await completeSetup(t);
    const res = await t.app.inject({
      method: method as 'GET',
      url,
      headers: SAME_ORIGIN,
      ...(method === 'GET' ? {} : { payload: {} }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('every route is 404 module_disabled while the module is off (default)', async () => {
    const s = await setup({ modules: { apps: false } });
    for (const [method, url] of ROUTES) {
      const res = await s.t.app.inject({
        method: method as 'GET',
        url,
        headers: s.headers,
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: 'module_disabled' });
    }
    expect(s.rpcs).toEqual([]);
  });
});

describe('apps: passwords', () => {
  it('are readable only with step-up and appear in no other response, audit entry or log', async () => {
    const s = await setup({ captureLogs: true });
    const pw = fakeSecret();
    const res = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { params: { ADMIN_TOKEN: pw } }),
    );
    expect(res.statusCode).toBe(202);
    await s.idle();
    // The secret is in .env on the server (that is where it belongs) ...
    const env = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> }).files[
      '.env'
    ];
    expect(env).toContain(`ADMIN_TOKEN='${pw}'`);
    // ... stored encrypted ...
    const row = s.t.db.sqlite.prepare('SELECT * FROM apps').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(pw);
    expect(row.secrets_enc).toMatch(/^v1:/);

    const id = installedAppSchema.parse(res.json()).id;
    const noStepUp = await appRequest(s, 'GET', `/api/apps/${id}/secrets`);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ error: 'step_up_required' });
    expect(noStepUp.body).not.toContain(pw);

    const bodies = [
      res.body,
      (await appRequest(s, 'GET', '/api/apps')).body,
      (await appRequest(s, 'GET', '/api/apps/templates')).body,
      (await appRequest(s, 'GET', '/api/apps/templates/vaultwarden')).body,
      (
        await appRequest(
          s,
          'POST',
          '/api/apps/templates/vaultwarden/preview',
          installBody(s, { appId: 'vault2', params: { ADMIN_TOKEN: pw, WEB_PORT: 8300 } }),
        )
      ).body,
      (await appRequest(s, 'POST', `/api/apps/${id}/update`)).body,
    ];
    await s.idle();
    for (const b of bodies) expect(b).not.toContain(pw);

    await stepUp(s.t, s.secret, s.cookie);
    const ok = await appRequest(s, 'GET', `/api/apps/${id}/secrets`);
    expect(ok.statusCode).toBe(200);
    expect(appSecretsResponseSchema.parse(ok.json())).toEqual({ values: { ADMIN_TOKEN: pw } });

    const audit = s.t.db.sqlite.prepare('SELECT * FROM audit_log').all();
    expect(JSON.stringify(audit)).not.toContain(pw);
    expect(JSON.stringify(audit)).toContain('app.secrets_viewed');
    expect(s.t.logs.join('\n')).not.toContain(pw);
  });

  it('an agent error that echoes the password is scrubbed', async () => {
    const s = await setup({ captureLogs: true });
    const pw = fakeSecret();
    s.behaviour.fail['compose.up'] = { code: 'failed', message: `bad env ADMIN_TOKEN=${pw}` };
    const res = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { params: { ADMIN_TOKEN: pw } }),
    );
    await s.idle();
    const list = await appRequest(s, 'GET', '/api/apps');
    expect(list.body).toContain('Container starten fehlgeschlagen');
    expect(list.body).not.toContain(pw);
    expect(res.body).not.toContain(pw);
    expect(JSON.stringify(s.t.db.sqlite.prepare('SELECT * FROM audit_log').all())).not.toContain(
      pw,
    );
    expect(s.t.logs.join('\n')).not.toContain(pw);
  });
});

describe('apps: remove', () => {
  it('needs step-up and the right app name', async () => {
    const s = await setup();
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    const id = installedAppSchema.parse(res.json()).id;
    await s.idle();

    const noStepUp = await appRequest(s, 'DELETE', `/api/apps/${id}`, { confirmName: 'vault' });
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ error: 'step_up_required' });

    await stepUp(s.t, s.secret, s.cookie);
    const wrong = await appRequest(s, 'DELETE', `/api/apps/${id}`, { confirmName: 'vaultx' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'confirm_mismatch' });
    // The display name is not the confirmation.
    const display = await appRequest(s, 'DELETE', `/api/apps/${id}`, {
      confirmName: 'Vaultwarden Familie',
    });
    expect(display.statusCode).toBe(400);
    expect((await appRequest(s, 'DELETE', `/api/apps/${id}`)).statusCode).toBe(400);
    expect(
      (await appRequest(s, 'DELETE', `/api/apps/${id}`, { confirmName: 'vault', extra: true }))
        .statusCode,
    ).toBe(400);
    expect(rpcsOf(s, 'app.remove')).toEqual([]);

    const ok = await appRequest(s, 'DELETE', `/api/apps/${id}`, { confirmName: 'vault' });
    expect(ok.statusCode).toBe(202);
    await s.idle();
    // deleteData defaults to false: the folder with data/ stays.
    expect(rpcsOf(s, 'app.remove').map((r) => r.params)).toEqual([
      { appId: 'vault', deleteData: false },
    ]);
  });

  it('a failed removal keeps the app with status error', async () => {
    const s = await setup();
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    const id = installedAppSchema.parse(res.json()).id;
    await s.idle();
    s.behaviour.fail['app.remove'] = { code: 'failed', message: 'busy device' };
    const rm = await withStepUp(s.t, () =>
      appRequest(s, 'DELETE', `/api/apps/${id}`, { confirmName: 'vault' }),
    );
    expect(rm.statusCode).toBe(202);
    await s.idle();
    const list = (await appRequest(s, 'GET', '/api/apps')).json<{ apps: { status: string }[] }>();
    expect(list.apps.map((a) => a.status)).toEqual(['error']);
  });
});

describe('apps: no internals, no echo', () => {
  it('never lists containers with hz.role, even in the app folder', async () => {
    const s = await setup();
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s));
    const id = installedAppSchema.parse(res.json()).id;
    await s.idle();
    s.running.set('hz-core', {
      dockerId: 'feedfeedfeed',
      name: 'hz-core',
      image: 'ghcr.io/x/core:1',
      composeProject: 'vault',
      composeDir: '/opt/homelab/apps/vault',
      state: 'running',
      health: 'none',
      statusText: 'Up',
      ports: [],
      role: 'core',
    });
    await s.sendInventory();
    const app = (await appRequest(s, 'GET', '/api/apps'))
      .json<{ apps: { id: string; containers: { name: string }[] }[] }>()
      .apps.find((a) => a.id === id);
    expect(app?.containers.map((c) => c.name)).toEqual(['vault']);
  });

  it('error responses never echo the request body', async () => {
    const s = await setup();
    const marker = 'zzMARKERzz';
    const bodies = [
      { ...installBody(s), name: `<script>${marker}`, appId: `${marker}/..` },
      { ...installBody(s), params: { DOMAIN: `https://${marker}\n` } },
      { ...installBody(s), params: { DOMAIN: `https://x.${marker}'` } },
    ];
    for (const b of bodies) {
      const r = await appRequest(s, 'POST', '/api/apps', b);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(marker);
    }
    const evil = customTemplate(
      `${SAFE_CUSTOM_COMPOSE}    environment:\n      X: "${marker} $${marker}"\n    privileged: "${marker}"\n`,
    );
    const r = await appRequest(s, 'POST', '/api/apps/templates', evil);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(marker);
  });

  it('install refuses a stored custom template that turned unsafe (defense in depth)', async () => {
    const s = await setup();
    const created = await appRequest(
      s,
      'POST',
      '/api/apps/templates',
      customTemplate(SAFE_CUSTOM_COMPOSE),
    );
    expect(created.statusCode).toBe(201);
    s.t.db.sqlite
      .prepare('UPDATE app_templates SET compose = ?')
      .run(SAFE_CUSTOM_COMPOSE.replace('./data/html', '/var/run/docker.sock'));
    const res = await appRequest(
      s,
      'POST',
      '/api/apps',
      installBody(s, { templateId: 'meine-app', appId: 'web' }),
    );
    expect(res.statusCode).toBe(400);
    expect(rpcsOf(s, 'compose.write')).toEqual([]);
  });
});

describe('apps: appId collisions (409 exists)', () => {
  const expectExists = async (s: AppsSetup, appId: string, fragment: string) => {
    const res = await appRequest(s, 'POST', '/api/apps', installBody(s, { appId }));
    expect(res.statusCode, appId).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, error: 'exists' });
    expect(res.json<{ message: string }>().message).toContain(fragment);
  };

  it('refuses names starting with homelab', async () => {
    const s = await setup();
    await expectExists(s, 'homelab-agent', 'reserviert');
    await expectExists(s, 'homelab', 'reserviert');
    expect(rpcsOf(s, 'compose.write')).toEqual([]);
  });

  it('refuses a compose project or folder of a foreign stack from the inventory', async () => {
    const s = await setup();
    const base = {
      image: 'busybox:1.36',
      state: 'running' as const,
      health: 'none' as const,
      statusText: 'Up',
      ports: [],
    };
    s.running.set('deploy-core', {
      ...base,
      dockerId: 'aaaa00000001',
      name: 'hz-core',
      composeProject: 'deploy',
      composeDir: '/srv/homelab/deploy',
    });
    s.running.set('handmade', {
      ...base,
      dockerId: 'aaaa00000002',
      name: 'old-wiki',
      composeProject: 'something',
      composeDir: '/opt/homelab/apps/wiki',
    });
    await s.sendInventory();
    await expectExists(s, 'deploy', 'Compose-Projekt');
    await expectExists(s, 'wiki', 'Compose-Projekt');
    expect(rpcsOf(s, 'compose.write')).toEqual([]);
    // The preview lists it as a problem too.
    const p = await appRequest(
      s,
      'POST',
      '/api/apps/templates/vaultwarden/preview',
      installBody(s, { appId: 'deploy' }),
    );
    expect(p.json<{ problems: string[] }>().problems.join()).toContain('Compose-Projekt');
  });

  it('refuses a folder used by a GitHub deploy target (same, above, below or same name)', async () => {
    const s = await setup();
    const now = s.t.clock.t;
    s.t.db.sqlite
      .prepare(
        "INSERT INTO github_repos (id, full_name, default_branch, created_at) VALUES ('r1', 'me/site', 'main', ?)",
      )
      .run(now);
    const add = s.t.db.sqlite.prepare(
      "INSERT INTO deploy_targets (id, repo_id, server_id, path, branch, method, created_at, updated_at) VALUES (?, 'r1', ?, ?, 'main', 'compose', ?, ?)",
    );
    add.run('d1', s.serverId, '/opt/homelab/apps/site', now, now);
    add.run('d2', s.serverId, '/opt/homelab/apps/blog/web', now, now);
    add.run('d3', s.serverId, '/opt/homelab/repos/shop', now, now);
    await expectExists(s, 'site', 'Deploy-Ziel');
    await expectExists(s, 'blog', 'Deploy-Ziel');
    await expectExists(s, 'shop', 'Deploy-Ziel');
    // An unrelated name is fine.
    const ok = await appRequest(s, 'POST', '/api/apps', installBody(s, { appId: 'vault' }));
    expect(ok.statusCode).toBe(202);
    await s.idle();
    // A second install into the same folder: exists.
    await expectExists(s, 'vault', 'gibt es auf dem Server schon');
  });
});
