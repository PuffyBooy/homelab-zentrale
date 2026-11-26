import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { answerStepUp, ORIGIN, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M9 wall mode (SPEC 12): a device link is created in the settings (step-up, shown once
 * with a QR code), the tablet opens /wall?t=<token> in a fresh browser without admin
 * login, the token leaves the address bar, the big tiles show up, the wall cookie can
 * read nothing but /api/wall/state, and a revoked device shows "Gerät nicht verbunden.".
 * Night dimming depends on the Vienna clock of the core (no test clock), so it is only
 * checked against the `night` flag the core reports.
 */

const SHOTS = 'docs/screenshots/m9';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const NAME = `heimserver-wall-${Date.now().toString(36)}`;
const DEVICE = 'Tablet Flur';

test.describe.configure({ mode: 'serial', timeout: 200_000 });

let admin: BrowserContext;
let page: Page;
let wallCtx: BrowserContext;
let wall: Page;
let totp: Totp;
let agent: SimAgent;
let deviceUrl = '';

async function status(p: Page, path: string): Promise<number> {
  return p.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).status, path);
}

test.beforeAll(async ({ browser }) => {
  // Hooks default to 30 s; signIn may wait ~26 s for a fresh TOTP window.
  test.setTimeout(120_000);
  admin = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await admin.newPage();
  totp = await signIn(page);
  const enroll = await page.evaluate(async (name) => {
    const res = await fetch('/api/servers/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, location: 'Wien' }),
    });
    return (await res.json()) as { token: string };
  }, NAME);
  agent = new SimAgent({ url: AGENT_URL, name: NAME, token: enroll.token });
  await agent.connect();
});

test.afterAll(async () => {
  agent?.disconnect();
  await wallCtx?.close();
  await admin?.close();
});

test('a wall device is created in the settings and its link is shown once', async () => {
  await page.goto('/settings#wandmodus');
  const tile = page.locator('#wandmodus');
  await tile.getByLabel('Gerätename').fill('<script>');
  await tile.getByRole('button', { name: 'Gerät hinzufügen' }).click();
  await expect(tile.getByText(/^1 bis 40 Zeichen/)).toBeVisible();

  await tile.getByLabel('Gerätename').fill(DEVICE);
  await tile.getByRole('button', { name: 'Gerät hinzufügen' }).click();
  await answerStepUp(page, totp);
  const dialog = page.getByRole('dialog', { name: `Link für ${DEVICE}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: /QR-Code/ })).toBeVisible();
  deviceUrl = (await dialog.locator('.app-copy-code').innerText()).trim();
  expect(deviceUrl).toMatch(/\/wall\?t=[A-Za-z0-9_-]{43}$/);
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.screenshot({ path: `${SHOTS}/wall-device-created-dark.png` });
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(tile.getByTestId('wall-device').filter({ hasText: DEVICE })).toBeVisible();
  // The token is not shown again.
  await expect(page.getByText(deviceUrl)).toHaveCount(0);
});

test('the tablet opens the link without admin login; the token leaves the URL', async ({
  browser,
}) => {
  wallCtx = await browser.newContext({
    colorScheme: 'light',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 800 },
  });
  wall = await wallCtx.newPage();
  const requests: string[] = [];
  wall.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) requests.push(u.pathname);
  });
  const path = new URL(deviceUrl).pathname + new URL(deviceUrl).search;
  await wall.goto(`${ORIGIN}${path}`);
  await expect(wall).toHaveURL(`${ORIGIN}/wall`);
  await expect(wall.locator('html')).toHaveAttribute('data-theme', 'wall');
  await expect(wall.getByTestId('wall-tile').first()).toBeVisible();
  await expect(wall.locator('.app-wall-sentence')).toHaveText(/\S/);
  await expect(wall.getByRole('navigation')).toHaveCount(0);
  await expect(wall.getByRole('button', { name: 'Vollbild' })).toBeVisible();
  const tiles = await wall
    .getByTestId('wall-tile')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tile')));
  expect(tiles).toContain('servers');
  // Only the wall endpoints, nothing that would need an admin session.
  expect([...new Set(requests)].sort()).toEqual(['/api/wall/session', '/api/wall/state']);
  // The token is not in the history either.
  expect(await wall.evaluate<string>('location.href')).not.toContain('t=');

  mkdirSync(SHOTS, { recursive: true });
  await wall.evaluate('document.fonts.ready');
  await wall.waitForTimeout(300);
  await wall.screenshot({ path: `${SHOTS}/wall-wall.png` });
  await wall.setViewportSize({ width: 800, height: 1280 });
  await wall.screenshot({ path: `${SHOTS}/wall-portrait-wall.png` });
  await wall.setViewportSize({ width: 1280, height: 800 });
});

test('the wall cookie reads only the wall state', async () => {
  expect(await status(wall, '/api/wall/state')).toBe(200);
  for (const p of [
    '/api/servers',
    '/api/auth/sessions',
    '/api/alerts',
    '/api/containers',
    '/api/settings/wall-devices',
    '/api/console/sessions',
  ]) {
    expect(await status(wall, p), p).toBe(401);
  }
  const cookies = await wallCtx.cookies();
  const c = cookies.find((x) => x.name === 'hz_wall');
  expect(c?.httpOnly).toBe(true);
  expect(c?.sameSite).toBe('Strict');
  expect(c?.path).toBe('/api/wall');
});

test('a server problem turns its tile red; night flag dims the rest', async () => {
  agent.disconnect();
  await expect(wall.locator('[data-tile="servers"]')).toHaveAttribute('data-tone', /crit|warn/, {
    timeout: 150_000,
  });
  const state = await wall.evaluate(async () => {
    const res = await fetch('/api/wall/state', { credentials: 'same-origin' });
    return (await res.json()) as { night: boolean };
  });
  await expect(wall.getByTestId('wall')).toHaveClass(state.night ? /app-wall-night/ : /^app-wall$/);
  await wall.screenshot({ path: `${SHOTS}/wall-problem-wall.png` });
  // Night view (the core decides by the Vienna clock): forced here only for the screenshot.
  await wall.evaluate("document.querySelector('.app-wall')?.classList.add('app-wall-night')");
  await wall.screenshot({ path: `${SHOTS}/wall-night-wall.png` });
  await agent.connect();
});

test('a revoked device shows "Gerät nicht verbunden."', async () => {
  await page.goto('/settings#wandmodus');
  const row = page.getByTestId('wall-device').filter({ hasText: DEVICE });
  await row.getByRole('button', { name: `${DEVICE} widerrufen` }).click();
  await page
    .getByRole('dialog', { name: `${DEVICE} widerrufen` })
    .getByRole('button', {
      name: 'Widerrufen',
    })
    .click();
  await expect(row).toHaveCount(0);
  expect(await status(wall, '/api/wall/state')).toBe(401);
  await wall.reload();
  await expect(wall.locator('.app-wall-sentence')).toHaveText('Gerät nicht verbunden.');

  // A broken link never reaches the core with a token.
  await wall.goto(`${ORIGIN}/wall?t=kaputt`);
  await expect(wall).toHaveURL(`${ORIGIN}/wall`);
  await expect(wall.locator('.app-wall-sentence')).toHaveText('Gerät nicht verbunden.');
});
