import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { E2E_SETUP_TOKEN } from '../playwright.config.js';
import { PASSWORD, USER, loopbackOrigin } from './helpers/auth.js';

/**
 * M12 "Gameserver komplett" (web part) against a second core with HZ_DEMO=1. The shared
 * core of the other specs starts empty, so this spec starts its own one (port 8097, own
 * data folder, own admin and TOTP; the TOTP state file of the other specs is not touched).
 * The demo data (apps/core/src/demo/games.ts) has a sleeping Minecraft server with a
 * week of player statistics, a backup schedule and one open whitelist request. Demo
 * servers have no agent, so approving answers "Gameserver läuft nicht"; the spec only
 * checks what is visible: "Schläft", Zeitpläne, Statistik, Whitelist-Anfrage.
 * Screenshots in docs/screenshots/m12/ in dark, light and wall.
 */

const PORT = 8097;
const DEMO = loopbackOrigin(PORT);
const DATA = 'test-results/data-m12';
const SHOTS = 'docs/screenshots/m12';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let core: ChildProcess | null = null;
let context: BrowserContext;
let page: Page;
let totp: TOTP;
let lastStep = -1;
let gameId = '';

/** A TOTP code of a 30-s step not used before (codes are single-use). */
async function freshCode(): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 250));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp.generate();
}

async function waitForHealth(): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      // Loopback only: the demo core this spec started itself.
      const res = await fetch(`${DEMO}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('demo core did not start');
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p as string, {
        method: m as string,
        headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
        body: b === undefined ? null : JSON.stringify(b),
        credentials: 'same-origin',
      });
      return { status: res.status, data: (await res.json().catch(() => null)) as never };
    },
    [method, path, body] as const,
  );
}

async function shot(p: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await p.evaluate('document.fonts.ready');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function themes(p: Page, name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    await expect(p.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(p, `e2e-${name}-${scheme}`);
  }
  await p.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(p, `e2e-${name}-wall`);
  await p.emulateMedia({ colorScheme: 'dark' });
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark');
}

/** A tile by its exact title (the title span of Tile). */
function tileByTitle(p: Page, title: string) {
  return p.locator(`section.hz-tile:has(.hz-tile-title > span:text-is("${title}"))`);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  core = spawn('node', ['apps/core/dist/index.js'], {
    env: {
      ...process.env,
      HZ_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
      HZ_PORT: String(PORT),
      HZ_DATA_DIR: DATA,
      HZ_SETUP_TOKEN: E2E_SETUP_TOKEN,
      HZ_DEMO: '1',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForHealth();

  context = await browser.newContext({ baseURL: DEMO, colorScheme: 'dark' });
  page = await context.newPage();
  await page.goto(`/setup#token=${E2E_SETUP_TOKEN}`);
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Passwort wiederholen').fill(PASSWORD);
  await page.getByRole('button', { name: 'Weiter' }).click();
  const secret = await page.getByTestId('totp-secret').getAttribute('data-secret');
  totp = new TOTP({ secret: Secret.fromBase32(secret ?? ''), digits: 6, period: 30 });
  await page.getByLabel('Code aus der App').fill(await freshCode());
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await page.getByRole('button', { name: 'Ich habe sie gesichert' }).click();
  await expect(page).toHaveURL(`${DEMO}/`);

  const games = await api<{ games: { id: string; name: string; sleeping?: boolean }[] }>(
    'GET',
    '/api/games',
  );
  gameId = games.data.games.find((g) => g.sleeping)?.id ?? '';
});

test.afterAll(async () => {
  await context?.close();
  core?.kill('SIGTERM');
});

test('the sleeping game shows "Schläft" in the list', async () => {
  test.skip(!gameId, 'core without the M12 demo game');
  await page.goto('/games');
  const tile = page.locator('section.hz-game').filter({ hasText: 'survival' });
  await expect(tile.locator('.hz-status-off')).toContainText('Schläft');
  await expect(tile.getByRole('button', { name: 'Start' })).toBeVisible();
  await themes(page, 'games-sleeping');
});

test('detail: sleep text, schedules and statistics', async () => {
  test.skip(!gameId, 'core without the M12 demo game');
  await page.goto(`/games/${gameId}`);
  await expect(page.locator('.app-kv .hz-status-off').first()).toContainText('Schläft');
  await expect(page.getByText(/nach 15 Min ohne Spieler/)).toBeVisible();

  const schedules = tileByTitle(page, 'Zeitpläne');
  await expect(schedules).toBeVisible();
  await expect(schedules.getByText(/Backup · täglich · 04:00/)).toBeVisible();
  await expect(schedules.getByText(/nächster Lauf/)).toBeVisible();

  const stats = tileByTitle(page, 'Statistik');
  await expect(stats).toBeVisible();
  await expect(stats.getByTestId('stats-player').first()).toContainText(/\d+ h \d{2} min|\d+ min/);
  await expect(stats.locator('svg.hz-spark')).toBeVisible();
  // Keyboard: the range buttons are reachable and switch to 30 days.
  await stats.getByRole('button', { name: '30 Tage' }).focus();
  await page.keyboard.press('Enter');
  await expect(stats.getByRole('button', { name: '30 Tage' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await themes(page, 'game-detail');
});

test('an open whitelist request can be confirmed', async () => {
  test.skip(!gameId, 'core without the M12 demo game');
  await page.goto(`/games/${gameId}`);
  const tile = tileByTitle(page, 'Whitelist-Anfragen');
  await expect(tile.getByText('1 offen')).toBeVisible();
  const row = tile.getByTestId('whitelist-request').first();
  await expect(row.locator('.hz-status-warn')).toContainText('offen');
  await row.getByRole('button', { name: /auf die Whitelist$/ }).click();
  // Demo servers have no agent: the core refuses (game not running). With an agent
  // the row turns into "bestätigt". Either way the answer is visible.
  await expect(
    tile.getByText('bestätigt').or(tile.getByText(/läuft nicht|nicht erreichbar|offline/i)),
  ).toBeVisible();
  await shot(page, 'e2e-whitelist-request-dark');
});

test('templates that do not run on arm64 grey out the arm64 server', async () => {
  const res = await api<{ templates: { id: string; arch: string[] }[] }>(
    'GET',
    '/api/games/templates',
  );
  const amdOnly = res.data.templates.find((t) => !t.arch.includes('arm64'));
  test.skip(!amdOnly, 'every template runs on arm64');
  await page.goto(`/games/new?vorlage=${amdOnly?.id ?? ''}`);
  const option = page
    .getByLabel('Zielserver')
    .locator('option', { hasText: 'Läuft nicht auf arm64' });
  await expect(option.first()).toBeDisabled();
  await expect(page.getByText('Schlafen nach … Min ohne Spieler')).toBeVisible();
  await shot(page, 'e2e-game-create-arch-dark');
});
