import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { E2E_SETUP_TOKEN } from '../playwright.config.js';
import { PASSWORD, USER, loopbackOrigin } from './helpers/auth.js';

/**
 * M15 "Game-Relay" (web part) against an own core with HZ_DEMO=1 (port 8098, own data
 * folder, own admin and TOTP). The demo data has one ingress and one game relayed through
 * it. Demo servers have no agent, so the spec only checks what is visible: Settings →
 * Eingänge and DNS, "Erreichbar über" on the game page, "über <Eingang>" in the list.
 * Screenshots in docs/screenshots/m15/ in dark, light and wall.
 */

const PORT = 8098;
const DEMO = loopbackOrigin(PORT);
const DATA = 'test-results/data-m15';
const SHOTS = 'docs/screenshots/m15';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface RelayGame {
  id: string;
  name: string;
  relay: { ingressName: string; address: string | null } | null;
}

let core: ChildProcess | null = null;
let context: BrowserContext;
let page: Page;
let totp: TOTP;
let lastStep = -1;
let relayGame: RelayGame | undefined;
let hasIngresses = false;

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

async function api<T>(method: string, path: string): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ([m, p]) => {
      const res = await fetch(p as string, { method: m as string, credentials: 'same-origin' });
      return { status: res.status, data: (await res.json().catch(() => null)) as never };
    },
    [method, path] as const,
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

  const games = await api<{ games: RelayGame[] }>('GET', '/api/games');
  relayGame = games.data.games.find((g) => g.relay);
  const ingresses = await api<{ ingresses: { enabled: boolean }[] }>('GET', '/api/relay/ingresses');
  hasIngresses = ingresses.status === 200 && ingresses.data.ingresses.some((i) => i.enabled);
});

test.afterAll(async () => {
  await context?.close();
  core?.kill('SIGTERM');
});

test('Settings: Eingänge lists the servers with state, firewall line and DNS', async () => {
  await page.goto('/settings#eingaenge');
  const tile = tileByTitle(page, 'Eingänge');
  await expect(tile).toBeVisible();
  await expect(tile.getByText(/Ein Eingang ist ein Server mit öffentlicher IPv4/)).toBeVisible();
  await expect(tileByTitle(page, 'DNS')).toBeVisible();
  await expect(tileByTitle(page, 'DNS').getByLabel('Anbieter')).toBeVisible();
  test.skip(!hasIngresses, 'core without the M15 demo ingress');

  const row = tile.getByTestId('ingress-row').filter({ has: page.locator('.hz-status-ok') });
  await expect(row.first()).toContainText('Bereit');
  await expect(row.first()).toContainText(/Ports \d+–\d+/);
  await expect(row.first().getByText(/Firewall des Anbieters/)).toBeVisible();

  // Keyboard: "Einstellen" opens the dialog, Escape closes it again.
  await row
    .first()
    .getByRole('button', { name: /^Eingang .+ einstellen$/ })
    .focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('ingress-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Öffentliche IPv4')).toBeFocused();
  await expect(dialog.getByText('Relay erlaubt', { exact: true })).toBeVisible();
  await shot(page, 'e2e-ingress-dialog-dark');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await themes(page, 'settings-ingresses');
});

test('game detail: "Erreichbar über" with ingress, state and address', async () => {
  test.skip(!relayGame, 'core without the M15 demo game');
  const g = relayGame as RelayGame;
  const via = g.relay?.ingressName ?? '';
  await page.goto(`/games/${g.id}`);
  const tile = tileByTitle(page, 'Erreichbar über');
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId('game-relay')).toContainText(via);
  await expect(
    tile.locator('.hz-status-ok, .hz-status-busy, .hz-status-crit').first(),
  ).toContainText(/Weiterleitung aktiv|Wartet auf den Eingang|Fehler am Eingang/);
  if (g.relay?.address) {
    await expect(tile.getByText(g.relay.address, { exact: true })).toBeVisible();
  }
  await expect(tile.getByRole('button', { name: 'Kopieren', exact: true })).toBeVisible();
  await expect(tile.getByLabel('Eingang', { exact: true })).toBeVisible();
  await expect(page.getByText('Kein Router-Portforwarding nötig.')).toBeVisible();
  await tile.scrollIntoViewIfNeeded();
  await themes(page, 'game-relay');
});

test('game list: "über <Eingang>" under the tile', async () => {
  test.skip(!relayGame, 'core without the M15 demo game');
  const g = relayGame as RelayGame;
  await page.goto('/games');
  const via = `über ${g.relay?.ingressName ?? ''}`;
  await expect(page.locator('.app-game-hint').getByText(via, { exact: true })).toBeVisible();
  await shot(page, 'e2e-games-relay-dark');
});
