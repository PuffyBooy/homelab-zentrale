import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { E2E_SETUP_TOKEN } from '../playwright.config.js';
import { ORIGIN, PASSWORD, Totp, USER } from './helpers/auth.js';

/**
 * M1 acceptance: first setup -> TOTP -> recovery codes -> overview with navigation,
 * logout, wrong TOTP, login. Runs in order on one browser context (the core DB is
 * wiped when the web server starts, so setup happens once per run).
 */

const SHOTS = 'docs/screenshots/m1';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
const foreign: string[] = [];
const cspErrors: string[] = [];

/** A TOTP code for a step the core has not seen yet (codes are single-use). */
function freshCode(): Promise<string> {
  return totp.fresh();
}

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  // Buttons fade their background for 120 ms after a theme change.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function inTheme(scheme: 'dark' | 'light', fn: () => Promise<void>): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await fn();
}

/** dark and light follow the system; wall is set by hand (the wall view comes in a later milestone). */
async function allThemes(name: string): Promise<void> {
  await inTheme('dark', () => shot(`${name}-dark`));
  await inTheme('light', () => shot(`${name}-light`));
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`${name}-wall`);
  await inTheme('dark', async () => undefined);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: ORIGIN, colorScheme: 'dark' });
  page = await context.newPage();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol.startsWith('http') && url.origin !== ORIGIN) foreign.push(req.url());
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content[- ]Security[- ]Policy/i.test(msg.text())) {
      cspErrors.push(msg.text());
    }
  });
});

test.afterAll(async () => {
  await context.close();
});

test('first setup: account, TOTP with QR, recovery codes, overview', async () => {
  await page.goto(`/setup#token=${E2E_SETUP_TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Admin-Konto anlegen.' })).toBeVisible();
  // The one-time token leaves the address bar.
  await expect(page).toHaveURL(`${ORIGIN}/setup`);

  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort', { exact: true }).fill('zu-kurz');
  await page.getByLabel('Passwort wiederholen').fill('zu-kurz');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByText('Zu kurz: mindestens 12 Zeichen.')).toBeVisible();

  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Passwort wiederholen').fill(PASSWORD);
  await page.getByRole('button', { name: 'Weiter' }).click();

  await expect(page.getByRole('heading', { name: 'Zweiten Faktor einrichten.' })).toBeVisible();
  const qr = page.getByRole('img', { name: 'QR-Code für die Authenticator-App' });
  await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect
    .poll(() => qr.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBeGreaterThan(0);
  const secret = await page.getByTestId('totp-secret').getAttribute('data-secret');
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  totp = new Totp(secret ?? '');

  await page.getByLabel('Code aus der App').fill(await freshCode());
  await page.getByRole('button', { name: 'Bestätigen' }).click();

  await expect(
    page.getByRole('heading', { name: 'Wiederherstellungscodes sichern.' }),
  ).toBeVisible();
  const codes = page.getByTestId('recovery-codes').getByRole('listitem');
  await expect(codes).toHaveCount(10);
  await page.getByRole('button', { name: 'Ich habe sie gesichert' }).click();

  await expect(page).toHaveURL(`${ORIGIN}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Noch nichts verbunden.');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link')).toHaveCount(9);
  await expect(nav.getByRole('link', { name: /Übersicht/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav).toHaveCSS('width', '210px');
  await expect(page.getByRole('tab', { name: 'Alle Server' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await allThemes('overview');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Schnellnavigation' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeHidden();
  await shot('overview-mobile-dark');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('shortcuts, command palette and theme switch', async () => {
  await page.keyboard.press('2');
  await expect(page).toHaveURL(`${ORIGIN}/servers`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Server');

  await page.keyboard.press('`');
  await expect(page).toHaveURL(`${ORIGIN}/console`);

  // NavRail links navigate client-side (no reload: the palette state survives).
  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: /Meldungen/ })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/alerts`);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Befehlspalette' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  // Digits typed into the palette do not navigate.
  await input.fill('2');
  await expect(page).toHaveURL(`${ORIGIN}/alerts`);
  await input.fill('Game');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(`${ORIGIN}/games`);

  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).toHaveText(/Server/);
  // Focus stays inside the dialog.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await palette.evaluate((d) => d.contains(d.ownerDocument.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Theme: follows the system until chosen, then remembered.
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /Theme: dunkel/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: /Theme: hell/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => localStorage.removeItem('hz-theme'));
});

test('settings list the session, logout ends it', async () => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Einstellungen');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('session-row')).toContainText('diese Sitzung');

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/login`);

  const res = await page.request.get('/api/auth/sessions');
  expect(res.status()).toBe(401);
});

test('without a session the API answers 401', async ({ request }) => {
  for (const path of ['/api/auth/sessions']) {
    const res = await request.get(path);
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  }
  const state = await request.get('/api/auth/state');
  expect(await state.json()).toMatchObject({ setupRequired: false, authenticated: false });
});

test('login with a wrong TOTP code shows an error', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(`${ORIGIN}/login`);
  await allThemes('login');

  const valid = totp.peek();
  const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort').fill(PASSWORD);
  await page.getByLabel('Code').fill(wrong);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('alert')).toContainText('Anmeldung abgelehnt.');
  await expect(page).toHaveURL(`${ORIGIN}/login`);
});

test('login with password and TOTP opens the overview', async () => {
  await page.goto('/servers');
  await expect(page).toHaveURL(`${ORIGIN}/login`);
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort').fill(PASSWORD);
  await page.getByLabel('Code').fill(await freshCode());
  await page.getByRole('button', { name: 'Anmelden' }).click();
  // Back to where the guard stopped us.
  await expect(page).toHaveURL(`${ORIGIN}/servers`);
  await page.keyboard.press('1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Noch nichts verbunden.');
});

test('no foreign hosts and no CSP violations', () => {
  expect(foreign).toEqual([]);
  expect(cspErrors).toEqual([]);
});
