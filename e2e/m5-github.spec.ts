import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN, signIn } from './helpers/auth.js';

/**
 * M5 smoke (web part), against the real core without GitHub access: without a token
 * the settings tile says so and checks the token format before sending, the GitHub
 * page shows the empty state with the way to the settings, and the overview tile
 * points there too. Deploys need GitHub and a git server; the deploy rules are unit
 * tested (apps/web/src/lib/github.test.ts, RepoListRow.test.tsx).
 */

const SHOTS = 'docs/screenshots/m5';

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

test('GitHub page without token shows the empty state and leads to the settings', async () => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  // Shortcut 5 opens the GitHub page.
  await page.keyboard.press('5');
  await expect(page).toHaveURL(`${ORIGIN}/github`);
  await expect(page.getByText('Kein GitHub-Token hinterlegt.')).toBeVisible();
  await expect(page.locator('.hz-page-title')).toContainText('Noch keine Repos.');
  await themes('github-empty');

  await page.getByRole('link', { name: 'Token in den Einstellungen eintragen' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings#github`);
});

test('settings tile says "kein Token" and checks the token format', async () => {
  const tile = page.locator('#github');
  await expect(tile.getByText('kein Token', { exact: true })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Token entfernen' })).toHaveCount(0);
  await expect(tile.getByRole('button', { name: 'Repo hinzufügen' })).toHaveCount(0);

  await tile.getByLabel('Token', { exact: true }).fill('hunter2');
  await tile.getByRole('button', { name: 'Token speichern' }).click();
  await expect(tile.getByText(/kein GitHub-Token/)).toBeVisible();
  // Nothing was sent: still no token.
  await expect(tile.getByText('kein Token', { exact: true })).toBeVisible();
  await tile.getByLabel('Token', { exact: true }).fill('');
  await themes('settings-github');
});

test('overview GitHub tile points to the settings', async () => {
  await page.goto('/');
  const servers = await page.evaluate(async () => {
    const res = await fetch('/api/servers', { credentials: 'same-origin' });
    return ((await res.json()) as { servers: unknown[] }).servers;
  });
  // Without servers the overview shows the enrollment hint instead of the tiles.
  test.skip(servers.length === 0, 'no server enrolled in this run');
  const tile = page.locator('.hz-tile').filter({ has: page.getByText('GitHub', { exact: true }) });
  await expect(tile.getByText('Kein Token hinterlegt.')).toBeVisible();
  await expect(tile.getByRole('link', { name: 'Alle Repos' })).toBeVisible();
});
