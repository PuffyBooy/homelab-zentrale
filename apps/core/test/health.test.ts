import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

const key = Buffer.alloc(32, 1).toString('base64');
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'hz-web-'));
}

describe('GET /api/health', () => {
  it('answers {ok:true}', async () => {
    app = await buildApp(
      loadConfig({ HZ_SECRET_KEY: key, NODE_ENV: 'test', HZ_WEB_DIR: emptyDir() }),
      { db: openDatabase(':memory:') },
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 401 for unknown API routes without a session', async () => {
    app = await buildApp(
      loadConfig({ HZ_SECRET_KEY: key, NODE_ENV: 'test', HZ_WEB_DIR: emptyDir() }),
      { db: openDatabase(':memory:') },
    );
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('web app serving', () => {
  it('serves index.html as SPA fallback, but not for /api', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hz</title>');
    app = await buildApp(loadConfig({ HZ_SECRET_KEY: key, NODE_ENV: 'test', HZ_WEB_DIR: dir }), {
      db: openDatabase(':memory:'),
    });

    const page = await app.inject({ method: 'GET', url: '/servers/heimserver' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<title>hz</title>');

    const api = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(api.statusCode).toBe(401);
    expect(api.headers['content-type']).toContain('application/json');
  });
});
