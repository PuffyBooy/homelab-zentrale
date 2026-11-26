import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

const key = Buffer.alloc(32, 7).toString('base64');

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const modulesOf = async (app: TestApp, cookie: string) =>
  (
    await app.app.inject({
      method: 'GET',
      url: '/api/settings/modules',
      headers: authHeaders(cookie),
    })
  ).json();

describe('HZ_INITIAL_MODULES (install wizard)', () => {
  it('parses 0/1 per known module, empty means unset', () => {
    expect(
      loadConfig({ HZ_SECRET_KEY: key, HZ_INITIAL_MODULES: 'github=1, homeassistant=0' })
        .initialModules,
    ).toEqual({ github: true, homeassistant: false });
    expect(loadConfig({ HZ_SECRET_KEY: key, HZ_INITIAL_MODULES: '' }).initialModules).toBe(
      undefined,
    );
    expect(loadConfig({ HZ_SECRET_KEY: key }).initialModules).toBe(undefined);
  });

  it('refuses unknown modules and values other than 0/1', () => {
    for (const v of ['nas=1', 'github=yes', 'github', 'github=1;rm -rf /']) {
      expect(() => loadConfig({ HZ_SECRET_KEY: key, HZ_INITIAL_MODULES: v })).toThrow(ConfigError);
    }
  });

  it('applies before the first setup', async () => {
    t = await makeApp({
      modules: 'fresh',
      env: { HZ_INITIAL_MODULES: 'github=1,homeassistant=1,games=0' },
    });
    const { cookie } = await completeSetup(t);
    expect(await modulesOf(t, cookie)).toEqual({ github: true, homeassistant: true, games: false });
  });

  it('is ignored once the admin exists (UI switches win after a restart)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hz-initial-modules-')), 'hz.sqlite');
    t = await makeApp({ modules: 'fresh', db: openDatabase(file) });
    const { cookie } = await completeSetup(t);
    await t.app.close();
    t = await makeApp({
      modules: 'fresh',
      db: openDatabase(file),
      env: { HZ_INITIAL_MODULES: 'github=1,games=0' },
    });
    // Same database, same session store: the old cookie is still valid.
    expect(await modulesOf(t, cookie)).toEqual({
      github: false,
      homeassistant: false,
      games: true,
    });
  });
});
