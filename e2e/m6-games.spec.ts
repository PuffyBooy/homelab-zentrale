import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN, signIn } from './helpers/auth.js';

/**
 * M6 smoke (web part), against the real core without a game container: the games page
 * shows the empty state, "Neuer Gameserver" opens the templates from templates/games,
 * picking one shows the form generated from template.json, and invalid input is caught
 * before anything is sent. Setup, RCON and backups need a running agent; their logic
 * is unit tested (apps/web/src/lib/games.test.ts, pages/games/games.test.tsx).
 */

const SHOTS = 'docs/screenshots/m6';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let context: BrowserContext;
let page: Page;

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function themes(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`e2e-${name}-${scheme}`);
  }
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`e2e-${name}-wall`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: ORIGIN, colorScheme: 'dark' });
  page = await context.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await context.close();
});

test('games page shows the empty state and leads to the templates', async () => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  // Shortcut 4 opens the game servers.
  await page.keyboard.press('4');
  await expect(page).toHaveURL(`${ORIGIN}/games`);
  await expect(page.locator('.hz-page-title')).toContainText('Noch keine Gameserver.');
  await themes('games-empty');

  await page.getByRole('button', { name: 'Neuer Gameserver' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/games/new`);
  await expect(page.locator('.hz-tpl').first()).toBeVisible();
  await expect(page.locator('.hz-tpl-name').first()).toHaveText(/\S/);
  await themes('game-templates');
});

test('the form comes from template.json and checks input before sending', async () => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/games') sent.push(r.url());
  });
  const mc = page.locator('.hz-tpl').filter({ hasText: 'Minecraft Java' });
  const pick = (await mc.count()) ? mc : page.locator('.hz-tpl').first();
  // Keyboard: the template cards are buttons.
  await pick.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/games\/new\?vorlage=/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Neuer Gameserver');
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Zielserver')).toBeVisible();
  await expect(page.getByLabel(/^Port /).first()).toBeVisible();
  await expect(page.getByText('Von außen erreichbar')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Survival Welt');
  await page.getByLabel('Auto-Stopp (Minuten ohne Spieler)').fill('5000');
  await page
    .getByLabel(/^Port /)
    .first()
    .fill('80');
  await page.getByRole('button', { name: 'Aufsetzen' }).click();

  await expect(
    page.getByText('Nur Kleinbuchstaben, Ziffern und Bindestrich (2–32 Zeichen).'),
  ).toBeVisible();
  await expect(page.getByText('Server auswählen.')).toBeVisible();
  await expect(page.getByText('Ganze Minuten von 0 bis 1440 (0 = aus).')).toBeVisible();
  await expect(page.getByText(/^Port von 1024 bis/)).toBeVisible();
  await expect(page.getByText(/Felder prüfen\./)).toBeVisible();
  // The first invalid field gets the focus.
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  expect(sent).toEqual([]);
  await themes('game-form-errors');

  await page.getByRole('button', { name: 'Andere Vorlage' }).click();
  await expect(page.locator('.hz-tpl').first()).toBeVisible();
});

test('overview shows the Gameserver tile next to Websites', async () => {
  await page.goto('/');
  const servers = await page.evaluate(async () => {
    const res = await fetch('/api/servers', { credentials: 'same-origin' });
    return ((await res.json()) as { servers: unknown[] }).servers;
  });
  test.skip(servers.length === 0, 'no server enrolled in this run');
  const tile = page
    .locator('.hz-tile')
    .filter({ has: page.getByText('Gameserver', { exact: true }) });
  await expect(tile.getByText('Noch keine Gameserver.')).toBeVisible();
});
