import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameSummary, HaState } from '@hz/shared';
import { staticCacheControl } from '../src/app.js';
import { fromLocal } from '../src/calendar.js';
import { openDatabase } from '../src/db/index.js';
import { exportFileName, removeStaleExports } from '../src/settings/export.js';
import { WallService } from '../src/wall/service.js';
import { stepUp } from './agent-helpers.js';
import {
  SAME_ORIGIN,
  authHeaders,
  completeSetup,
  emptyDir,
  login,
  makeApp,
  totpCode,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;

afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;

describe('POST /api/settings/export', () => {
  async function setup() {
    const dataDir = emptyDir();
    t = await makeApp({ env: { HZ_DATA_DIR: dataDir } });
    const s = await completeSetup(t);
    return { t, dataDir, ...s };
  }

  it('needs a session (401), the same Origin (403) and step-up (403)', async () => {
    const e = await setup();
    expect(
      (await e.t.app.inject({ method: 'POST', url: '/api/settings/export', headers: SAME_ORIGIN }))
        .statusCode,
    ).toBe(401);
    await stepUp(e.t, e.secret, e.cookie);
    const foreign = await e.t.app.inject({
      method: 'POST',
      url: '/api/settings/export',
      headers: {
        host: 'hz.test',
        origin: 'https://evil.example',
        cookie: `hz_session=${e.cookie}`,
      },
    });
    expect(foreign.statusCode).toBe(403);
    e.t.clock.advance(16 * MIN);
    const res = await e.t.app.inject({
      method: 'POST',
      url: '/api/settings/export',
      headers: authHeaders(e.cookie),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    expect(readdirSync(e.dataDir)).toEqual([]);
  });

  it('streams a valid SQLite snapshot, removes the temp file, audits', async () => {
    const e = await setup();
    await stepUp(e.t, e.secret, e.cookie);
    e.t.clock.t = fromLocal(2026, 11, 26, 23, 4);
    // The session is still valid; step-up again at the new time.
    await stepUp(e.t, e.secret, e.cookie);
    const res = await e.t.app.inject({
      method: 'POST',
      url: '/api/settings/export',
      headers: authHeaders(e.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="homelab-zentrale-20261126-2304.sqlite"',
    );
    const body = res.rawPayload;
    expect(body.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');
    expect(Number(res.headers['content-length'])).toBe(body.length);

    const out = join(emptyDir(), 'copy.sqlite');
    writeFileSync(out, body);
    const copy = new Database(out, { readonly: true });
    const user = copy.prepare('SELECT username, totp_secret_enc FROM users').get() as {
      username: string;
      totp_secret_enc: string;
    };
    expect(user.username).toBe('admin');
    // Secrets stay encrypted in the export.
    expect(user.totp_secret_enc).not.toContain(e.secret);
    const v = copy.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(9);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(e.dataDir)).toEqual([]);
    const audit = e.t.db.sqlite
      .prepare("SELECT details_json FROM audit_log WHERE action = 'settings.export'")
      .all();
    expect(audit).toHaveLength(1);
  });

  it('runs at most one export at a time', async () => {
    const e = await setup();
    await stepUp(e.t, e.secret, e.cookie);
    const req = () =>
      e.t.app.inject({
        method: 'POST',
        url: '/api/settings/export',
        headers: authHeaders(e.cookie),
      });
    const [a, b] = await Promise.all([req(), req()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await new Promise((r) => setTimeout(r, 50));
    expect((await req()).statusCode).toBe(200);
  });

  it('file name in Vienna time; stale temp files are removed', async () => {
    expect(exportFileName(fromLocal(2026, 3, 29, 3, 7))).toBe(
      'homelab-zentrale-20260329-0307.sqlite',
    );
    expect(exportFileName(Date.UTC(2026, 11, 31, 23, 30))).toBe(
      'homelab-zentrale-20270101-0030.sqlite',
    );
    const dir = emptyDir();
    writeFileSync(join(dir, '.export-AAAAAAAAAAAAAAAAAAAAAA.sqlite'), 'x');
    writeFileSync(join(dir, 'hz.sqlite'), 'x');
    mkdirSync(join(dir, 'sub'));
    expect(await removeStaleExports(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['hz.sqlite', 'sub']);
  });
});

describe('TOTP re-setup', () => {
  it('needs step-up; the new secret only counts after confirm with its code', async () => {
    t = await makeApp();
    const { cookie, secret } = await completeSetup(t);
    const other = await login(t, totpCode(secret, (t.clock.advance(30_000), t.clock.t)));
    const otherCookie = other.cookies.find((c) => c.name === 'hz_session')?.value ?? '';
    expect(other.statusCode).toBe(200);

    t.clock.advance(16 * MIN);
    const noStepUp = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/start',
      headers: authHeaders(cookie),
    });
    expect(noStepUp.statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/auth/totp/start', headers: SAME_ORIGIN }))
        .statusCode,
    ).toBe(401);

    await stepUp(t, secret, cookie);
    const noPending = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      headers: authHeaders(cookie),
      payload: { code: '123456' },
    });
    expect(noPending.statusCode).toBe(409);

    const start = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/start',
      headers: authHeaders(cookie),
    });
    expect(start.statusCode).toBe(200);
    const fresh = start.json<{ secret: string; otpauthUri: string; qrSvg: string }>();
    expect(fresh.secret).not.toBe(secret);
    expect(fresh.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    for (const code of ['12345', 'abcdef']) {
      const bad = await t.app.inject({
        method: 'POST',
        url: '/api/auth/totp/confirm',
        headers: authHeaders(cookie),
        payload: { code },
      });
      expect(bad.statusCode).toBe(400);
    }
    // A code of the OLD secret does not confirm.
    t.clock.advance(30_000);
    const old = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      headers: authHeaders(cookie),
      payload: { code: totpCode(secret, t.clock.t) },
    });
    expect(old.statusCode).toBe(403);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      headers: authHeaders(cookie),
      payload: { code: totpCode(fresh.secret, t.clock.t) },
    });
    expect(ok.statusCode).toBe(200);
    // Other sessions are gone, this one stays.
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/auth/sessions',
          headers: authHeaders(otherCookie),
        })
      ).statusCode,
    ).toBe(401);
    // Step-up now works with the new secret only.
    t.clock.advance(30_000);
    const withOld = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: totpCode(secret, t.clock.t) },
    });
    expect(withOld.statusCode).toBe(403);
    t.clock.advance(30_000);
    const withNew = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: totpCode(fresh.secret, t.clock.t) },
    });
    expect(withNew.statusCode).toBe(200);
    const actions = (
      t.db.sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'auth.totp%'").all() as {
        action: string;
      }[]
    ).map((r) => r.action);
    expect(actions).toEqual([
      'auth.totp_reset_started',
      'auth.totp_reset_failed',
      'auth.totp_changed',
    ]);
    expect(JSON.stringify(t.db.sqlite.prepare('SELECT * FROM audit_log').all())).not.toContain(
      fresh.secret,
    );
  });
});

describe('static web assets', () => {
  it('hashed assets are immutable, everything else no-cache', () => {
    expect(staticCacheControl('/srv/web/assets/index-Bj0WDAOK.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/web/assets/index-D96jNvHS.css.br')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/web/index.html')).toBe('no-cache');
    expect(staticCacheControl('/srv/web/sw.js')).toBe('no-cache');
    expect(staticCacheControl('/srv/web/fonts/inter.woff2')).toBe('no-cache');
  });

  it('serves pre-compressed files with the right headers; /console reload is the app', async () => {
    const web = emptyDir();
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>hz</title>');
    writeFileSync(join(web, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
    writeFileSync(join(web, 'assets', 'index-AbCdEf12.js.br'), 'BROTLI');
    writeFileSync(join(web, 'assets', 'index-AbCdEf12.js.gz'), 'GZIP');
    t = await makeApp({ env: { HZ_WEB_DIR: web } });
    const br = await t.app.inject({
      method: 'GET',
      url: '/assets/index-AbCdEf12.js',
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.body).toBe('BROTLI');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(String(br.headers.vary)).toContain('accept-encoding');
    const gz = await t.app.inject({
      method: 'GET',
      url: '/assets/index-AbCdEf12.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
    const plain = await t.app.inject({ method: 'GET', url: '/assets/index-AbCdEf12.js' });
    expect(plain.body).toBe('console.log(1)');
    const index = await t.app.inject({ method: 'GET', url: '/' });
    expect(index.headers['cache-control']).toBe('no-cache');
    for (const url of ['/console?serverId=abc', '/wall', '/servers/x']) {
      const page = await t.app.inject({ method: 'GET', url });
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain('<title>hz</title>');
      expect(page.headers['cache-control'], url).toBe('no-cache');
    }
  });
});

describe('wall tiles from games and Home Assistant', () => {
  function service(games: Partial<GameSummary>[], ha: Partial<HaState>) {
    const h = openDatabase(':memory:');
    const haState: HaState = {
      status: 'connected',
      error: null,
      rooms: [],
      items: [],
      energy: null,
      updatedAt: new Date(0).toISOString(),
      ...ha,
    };
    const svc = new WallService({
      db: h.db,
      now: () => Date.UTC(2026, 10, 26, 12),
      sources: {
        servers: () => [],
        games: () => games as GameSummary[],
        ha: () => haState,
      },
    });
    return { svc, close: () => h.close() };
  }
  const item = (o: Partial<HaState['items'][number]>): HaState['items'][number] => ({
    entityId: 'sensor.x',
    kind: 'metric',
    roomId: null,
    label: 'X',
    overview: false,
    state: '1',
    value: 1,
    unit: null,
    deviceClass: null,
    available: true,
    lastChanged: null,
    pending: false,
    ...o,
  });

  it('players: sum of running games; temperature: overview sensor first; power from HA', () => {
    const { svc, close } = service(
      [
        { status: 'ok', players: { online: 3, max: 10, names: [] } },
        { status: 'warn', players: { online: 2, max: 10, names: [] } },
        { status: 'off', players: null },
      ],
      {
        items: [
          item({
            entityId: 'sensor.aussen',
            label: 'Außen',
            deviceClass: 'temperature',
            value: 4.2,
            unit: '°C',
          }),
          item({ entityId: 'sensor.strom', deviceClass: 'power', value: 400, overview: true }),
          item({
            entityId: 'climate.wohnzimmer',
            label: 'climate.wohnzimmer',
            value: 21.5,
            unit: '°C',
            overview: true,
          }),
        ],
        energy: { powerW: 1234.4, monthKwh: null, monthEur: null, pricePerKwh: 0.25 },
      },
    );
    const s = svc.state();
    close();
    expect(s.tiles.find((x) => x.id === 'players')).toMatchObject({
      value: '5',
      hint: '2 Gameserver laufen',
      tone: 'ok',
    });
    // Overview climate wins; its label is the entity id, so no hint (no ids on the wall).
    expect(s.tiles.find((x) => x.id === 'temperature')).toMatchObject({
      value: '21,5',
      unit: '°C',
      hint: null,
      tone: 'ok',
    });
    expect(s.tiles.find((x) => x.id === 'power')?.value).toMatch(/^1.234$/);
    expect(JSON.stringify(s)).not.toContain('climate.wohnzimmer');
  });

  it('without HA and games the tiles are off', () => {
    const { svc, close } = service([], { status: 'off' });
    const s = svc.state();
    close();
    expect(s.tiles.find((x) => x.id === 'temperature')).toMatchObject({
      value: '–',
      tone: 'off',
      hint: 'Home Assistant nicht eingerichtet',
    });
    expect(s.tiles.find((x) => x.id === 'players')).toMatchObject({ value: '0', tone: 'off' });
  });
});
