import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { answerStepUp, login, ORIGIN, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M9 web console (SPEC 11) against the real core and a simulated agent with an echo PTY
 * (e2e/helpers/sim-agent.ts): the server picker shows why a server is not usable, the
 * console is allowed in the settings (step-up), connecting in a fresh session asks for
 * the code first, keystrokes reach the agent and the echo comes back, the terminal size
 * follows the window, and every way a session ends has a German reason.
 */

const SHOTS = 'docs/screenshots/m9';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const NAME = `heimserver-m9-${Date.now().toString(36)}`;
const OTHER = `pi-m9-${Date.now().toString(36)}`;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
let other: SimAgent;

async function apiCall<T>(
  p: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return p.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
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

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function themes(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`${name}-${scheme}`);
  }
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`${name}-wall`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

async function enroll(name: string, terminal: boolean): Promise<SimAgent> {
  const res = await apiCall<{ token: string }>(page, 'POST', '/api/servers/enroll', {
    name,
    location: 'Wien',
  });
  expect(res.status).toBe(200);
  const a = new SimAgent({ url: AGENT_URL, name, token: res.data.token, terminal });
  await a.connect();
  return a;
}

const status = (p: Page = page) => p.getByTestId('console-status');
const target = (name: string, p: Page = page) =>
  p.getByTestId('console-target').filter({ hasText: name });
const screen = (p: Page = page) => p.locator('.app-xterm .xterm-rows');

test.beforeAll(async ({ browser }) => {
  // Hooks default to 30 s; signIn may wait ~26 s for a fresh TOTP window.
  test.setTimeout(120_000);
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  agent = await enroll(NAME, true);
  other = await enroll(OTHER, false);
});

test.afterAll(async () => {
  agent?.disconnect();
  other?.disconnect();
  await context?.close();
});

test('the picker lists servers without the console as disabled, with the reason', async () => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await page.keyboard.press('`');
  await expect(page).toHaveURL(`${ORIGIN}/console`);
  await expect(page.locator('.hz-page-title')).toHaveText('Keine Konsole verfügbar.');
  const row = target(NAME);
  await expect(row).toContainText('Konsole nicht erlaubt (Einstellungen → Server)');
  await expect(row.getByRole('button', { name: `Konsole ${NAME} verbinden` })).toBeDisabled();
});

test('allowing the console in the settings needs step-up', async () => {
  await page.goto('/settings#server');
  const row = page.getByTestId('settings-server').filter({ hasText: NAME });
  await row.getByRole('button', { name: `${NAME} bearbeiten` }).click();
  const dialog = page.getByRole('dialog', { name: `${NAME} bearbeiten` });
  await dialog.getByRole('switch', { name: 'Konsole erlaubt' }).click();
  await answerStepUp(page, totp);
  await expect(dialog.getByRole('switch', { name: 'Konsole erlaubt' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.getByText('HZ_AGENT_ALLOW_TERMINAL=1')).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  // The other server: allowed in the core, but its agent has no terminal capability.
  const o = await apiCall<{ server: { id: string } }>(page, 'GET', '/api/servers');
  expect(o.status).toBe(200);
  const otherId = other.serverId ?? '';
  const patch = await apiCall(page, 'PATCH', `/api/servers/${otherId}`, { allowTerminal: true });
  expect(patch.status).toBe(200);
});

test('a fresh session asks for the code before the console opens', async ({ browser }) => {
  const fresh = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  const p = await fresh.newPage();
  await login(p, totp);
  await p.goto('/console');
  await expect(p.locator('.hz-page-title')).toHaveText(/^Konsole bereit auf 2 von/);
  await target(NAME, p)
    .getByRole('button', { name: `Konsole ${NAME} verbinden` })
    .click();
  const stepUp = p.getByRole('dialog', { name: 'Mit Code bestätigen' });
  await expect(stepUp).toBeVisible();
  await expect(status(p)).toContainText('Warte auf den Code aus der App');
  // Cancel: no socket, a clear reason.
  await stepUp.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(status(p)).toContainText('Abgebrochen. Ohne Code aus der App keine Konsole.');
  await p.getByRole('button', { name: 'Neu verbinden' }).click();
  await answerStepUp(p, totp);
  await expect(status(p)).toContainText(`verbunden mit ${NAME}`);
  await expect(screen(p)).toContainText(`Simulierte Shell auf ${NAME}`);
  await p.getByRole('button', { name: 'Trennen' }).click();
  await expect(status(p)).toContainText('Getrennt. Sitzung geschlossen.');
  await fresh.close();
});

test('keystrokes reach the agent, the echo comes back, the size follows the window', async () => {
  await page.goto('/console');
  await target(NAME)
    .getByRole('button', { name: `Konsole ${NAME} verbinden` })
    .click();
  // Step-up from the settings test is still valid (15 min): no dialog.
  await expect(status()).toContainText(`verbunden mit ${NAME}`);
  await expect(page.getByRole('dialog', { name: 'Mit Code bestätigen' })).toHaveCount(0);
  await expect(screen()).toContainText(`alex@${NAME}:~$`);
  await page.keyboard.type('uptime');
  await page.keyboard.press('Enter');
  await expect(screen()).toContainText('echo: uptime');
  expect(agent.ptyInput).toContain('uptime\r');
  // Mono font from the tokens.
  expect(
    await page.evaluate<string>(
      'getComputedStyle(document.querySelector(".app-xterm .xterm-rows")).fontFamily',
    ),
  ).toContain('JetBrains Mono');
  // Shell shortcuts stay in the terminal: Ctrl+K does not open the palette, digits do not navigate.
  await page.keyboard.press('Control+k');
  await page.keyboard.press('2');
  await expect(page.getByRole('dialog', { name: 'Befehlspalette' })).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}/console`);

  const first = agent.ptySizes[0];
  expect(first?.cols).toBeGreaterThan(40);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect
    .poll(() => agent.ptySizes.at(-1)?.cols ?? 0, { timeout: 10_000 })
    .toBeLessThan(first?.cols ?? 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(() => agent.ptySizes.at(-1)?.cols ?? 0, { timeout: 10_000 })
    .toBe(first?.cols ?? -1);

  // F6 leaves the terminal for the keyboard.
  await page.keyboard.press('F6');
  await expect(page.getByRole('button', { name: 'Trennen' })).toBeFocused();
  await themes('console');
});

test('every end of a session has a German reason', async () => {
  agent.ptyExit(0);
  await expect(status()).toContainText('Getrennt. Shell beendet.');

  await page.getByRole('button', { name: 'Neu verbinden' }).click();
  await expect(status()).toContainText(`verbunden mit ${NAME}`);
  agent.ptyExit(2);
  await expect(status()).toContainText('Shell beendet mit Code 2.');

  // The agent without the terminal capability.
  await target(OTHER)
    .getByRole('button', { name: `Konsole ${OTHER} verbinden` })
    .click();
  await expect(status()).toContainText('Konsole auf dem Agent aus. HZ_AGENT_ALLOW_TERMINAL=1');

  // Agent drops while connected.
  await target(NAME)
    .getByRole('button', { name: `Konsole ${NAME} verbinden` })
    .click();
  await expect(status()).toContainText(`verbunden mit ${NAME}`);
  agent.disconnect();
  await expect(status()).toContainText('Agent offline');
  await expect(target(NAME)).toContainText('Agent offline');
  await agent.connect();
  await expect(target(NAME).getByRole('button', { name: /verbinden/ })).toBeEnabled({
    timeout: 15_000,
  });

  // The console is switched off while a session runs.
  await target(NAME)
    .getByRole('button', { name: `Konsole ${NAME} verbinden` })
    .click();
  await expect(status()).toContainText(`verbunden mit ${NAME}`);
  const off = await apiCall(page, 'PATCH', `/api/servers/${agent.serverId ?? ''}`, {
    allowTerminal: false,
  });
  expect(off.status).toBe(200);
  await expect(status()).toContainText('Konsole für diesen Server nicht erlaubt', {
    timeout: 15_000,
  });
  const on = await apiCall(page, 'PATCH', `/api/servers/${agent.serverId ?? ''}`, {
    allowTerminal: true,
  });
  expect(on.status).toBe(200);
});

test('sessions are listed without keystrokes, palette opens "Konsole <server>"', async () => {
  await page.reload();
  const rows = page.getByTestId('console-session').filter({ hasText: NAME });
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('console-session').filter({ hasText: 'uptime' })).toHaveCount(0);
  const list = await apiCall<{ sessions: Record<string, unknown>[] }>(
    page,
    'GET',
    '/api/console/sessions',
  );
  expect(JSON.stringify(list.data)).not.toContain('uptime');

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Wohin?' }).fill(`konsole ${NAME}`);
  await expect(page.getByRole('option', { name: new RegExp(`Konsole ${NAME}`) })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${ORIGIN}/console`);
  await expect(status()).toContainText(`verbunden mit ${NAME}`);
  await page.getByRole('button', { name: 'Trennen' }).click();
  await expect(status()).toContainText('Sitzung geschlossen.');
});
