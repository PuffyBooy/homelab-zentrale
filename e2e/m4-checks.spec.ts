import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN, signIn } from './helpers/auth.js';

/**
 * M4 smoke (web part): a TCP check on 127.0.0.1:1 (nothing listens there) is created
 * through the form, shows up in the list, turns DOWN after two failed runs, raises a
 * check alert, and can be deleted with confirmation. Push needs a real browser
 * subscription and is covered by unit tests (apps/web/src/sw-push.test.ts).
 */

const SHOTS = 'docs/screenshots/m4';
const TARGET = '127.0.0.1:1';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

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

function row() {
  return page.locator('.hz-web').filter({ hasText: TARGET });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: ORIGIN, colorScheme: 'dark' });
  page = await context.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await context.close();
});

test('create a TCP check and see it in the list', async () => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  // Shortcut 6 opens the websites page.
  await page.keyboard.press('6');
  await expect(page).toHaveURL(`${ORIGIN}/websites`);

  await page.getByRole('button', { name: 'Check anlegen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check anlegen' });
  await dialog.getByLabel('Art', { exact: true }).selectOption('tcp');
  await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill('70000');
  await dialog.getByRole('button', { name: 'Anlegen', exact: true }).click();
  await expect(dialog.getByText('Port zwischen 1 und 65535.')).toBeVisible();
  await dialog.getByLabel('Port', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Anlegen', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(row()).toBeVisible();
  await expect(row().locator('.hz-web-code')).toHaveText('TCP');
});

test('two failed runs turn the check DOWN and raise an alert', async () => {
  const run = page.getByRole('button', { name: `${TARGET} jetzt prüfen` });
  await run.click();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(run).toBeEnabled();
  await expect(row().locator('.hz-status-label')).toHaveText('DOWN', { timeout: 30_000 });
  await expect(page.locator('.hz-page-title')).toContainText(`${TARGET} ist nicht erreichbar`);
  await themes('websites-down');

  await page.goto('/alerts?source=check');
  await expect(page.getByTestId('alert-line').filter({ hasText: TARGET }).first()).toBeVisible({
    timeout: 30_000,
  });
  await themes('alerts-check');
});

test('detail with range switch, then delete with confirmation', async () => {
  await page.goto('/websites');
  await page.getByRole('button', { name: `${TARGET} öffnen` }).click();
  await expect(page).toHaveURL(/\/websites\/[A-Za-z0-9_-]{8,64}$/);
  await page.getByRole('button', { name: '7 T' }).click();
  await expect(page.getByRole('button', { name: '7 T' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Verlauf 7 T')).toBeVisible();
  await themes('website-detail');

  await page.getByRole('button', { name: 'Löschen' }).click();
  const confirm = page.getByRole('dialog', { name: /löschen$/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Löschen' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/websites`);
  await expect(row()).toHaveCount(0);
});
