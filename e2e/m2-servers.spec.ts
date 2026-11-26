import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { answerStepUp, login, ORIGIN, pageFetch, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M2 acceptance (docs/ROADMAP.md): enrollment through the dialog, two simulated agents
 * appear live (no reload), the detail page shows their values, a stopped agent turns
 * DOWN and raises a crit alert. The offline threshold is lowered to 30 s via PATCH so
 * the run stays short. "Token erzeugen" needs step-up (decision 2026-11-26).
 */

const SHOTS = 'docs/screenshots/m2';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;

test.describe.configure({ mode: 'serial', timeout: 150_000 });

let context: BrowserContext;
let page: Page;
const agents: SimAgent[] = [];
let navigations = 0;
let totp: Totp;

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** dark and light follow the system colour scheme; wall is set by hand. */
async function themes(name: string, wall = false): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`${name}-${scheme}`);
  }
  if (wall) {
    await page.evaluate("document.documentElement.dataset.theme = 'wall'");
    await shot(`${name}-wall`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

/**
 * Same-origin fetch from inside the page. Playwright's request context does not send the
 * Secure session cookie over plain http to 127.0.0.1, the browser does.
 */
async function apiCall<T>(
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

function serverRows() {
  return page.locator('.hz-srvlist').getByRole('listitem');
}

function serverRow(name: string) {
  return serverRows().filter({ hasText: name });
}

test.beforeAll(async ({ browser }) => {
  // signIn may wait for a fresh TOTP window (hooks have their own 30-s default).
  test.setTimeout(120_000);
  // The core writes alert texts in Vienna time; the browser shows the same.
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
  });
  page = await context.newPage();
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  totp = await signIn(page);
});

test.afterAll(async () => {
  for (const a of agents) a.disconnect();
  await context.close();
});

test('empty overview offers "Server hinzufügen"', async () => {
  await page.goto('/');
  const { data } = await apiCall<{ servers: unknown[] }>('GET', '/api/servers');
  const servers = data.servers;
  test.skip(servers.length > 0, 'core already has servers (reused server)');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Noch nichts verbunden.');
  await expect(page.getByRole('button', { name: 'Server hinzufügen' })).toBeVisible();
  await themes('overview-empty');
});

test('enroll through the dialog, agent appears live', async () => {
  await page.goto('/');
  const before = navigations;
  await page.getByRole('button', { name: 'Server hinzufügen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Server hinzufügen' });
  await expect(dialog).toBeVisible();
  // Since M11 the code flow is the default; the token path is "Manuell (Token)".
  await dialog.getByRole('button', { name: 'Manuell (Token)' }).click();

  // Name is checked against agentNameSchema before anything is sent.
  await dialog.getByLabel('Name').fill('Heim Server');
  await dialog.getByRole('button', { name: 'Token erzeugen' }).click();
  await expect(dialog.getByText(/Name ungültig/)).toBeVisible();

  await dialog.getByLabel('Name').fill('heimserver');
  await dialog.getByLabel('Ort').fill('Zuhause');
  await themes('enroll-form');
  await dialog.getByRole('button', { name: 'Token erzeugen' }).click();
  // Enrollment needs a fresh code; the dialog asks and the request is retried.
  await answerStepUp(page, totp);

  await expect(dialog.getByText(/Warte auf heimserver/)).toBeVisible();
  await expect(dialog.getByText('Einzeiler (docker run)')).toBeVisible();
  await expect(dialog.getByText(/noch 1[45] Min/)).toBeVisible();
  const token = (await dialog.locator('code.app-copy-code').textContent())?.trim() ?? '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
  await expect(dialog.locator('pre').first()).toContainText(token);
  await themes('enroll-token');

  const agent = new SimAgent({ url: AGENT_URL, name: 'heimserver', token });
  agents.push(agent);
  await agent.connect();
  expect(agent.agentToken).toBeTruthy();

  await expect(dialog.getByText('heimserver ist verbunden')).toBeVisible({ timeout: 15_000 });
  await themes('enroll-connected');
  await dialog.getByRole('button', { name: 'Schließen' }).click();

  const row = serverRow('heimserver');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Zuhause');
  await expect(row).toContainText('23%');
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Noch nichts verbunden.');
  expect(navigations).toBe(before);
});

test('second agent appears live, overview and list', async () => {
  const res = await apiCall<{ token: string }>('POST', '/api/servers/enroll', {
    name: 'oracle-a1',
    location: 'Frankfurt',
  });
  expect(res.status).toBe(200);
  const { token } = res.data;
  const before = navigations;
  const agent = new SimAgent({
    url: AGENT_URL,
    name: 'oracle-a1',
    token,
    tailscaleIp: '100.64.0.21',
    cpu: 64,
    ramUsed: 22 * 1024 ** 3,
    ramTotal: 24 * 1024 ** 3,
    temp: null,
  });
  agents.push(agent);
  await agent.connect();

  await expect(serverRow('oracle-a1')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('tab', { name: /oracle-a1/ })).toBeVisible();
  expect(navigations).toBe(before);
  await themes('overview', true);

  await page.keyboard.press('2');
  await expect(page).toHaveURL(`${ORIGIN}/servers`);
  await expect(serverRows()).toHaveCount(2);
  await themes('servers', true);
});

test('detail page shows values, cleanup preview and reboot confirmation', async () => {
  // The enrollment left a step-up on this session; a new session must be asked again.
  await pageFetch(page, 'POST', '/api/auth/logout', {});
  await login(page, totp);
  await page.goto('/servers');
  await serverRow('heimserver').click();
  await expect(page).toHaveURL(/\/servers\/[A-Za-z0-9_-]+$/);
  const main = page.getByRole('main');
  await expect(main.getByText('7,8 / 16 GB · 49 %')).toBeVisible();
  await expect(main.getByText('389 / 480 GB · 81 %')).toBeVisible();
  await expect(main.getByText('44,5 °C')).toBeVisible();
  await expect(main.getByText('6.1.0-28-amd64')).toBeVisible();
  await expect(main.getByText('12 T 4 h')).toBeVisible();
  await expect(main.getByText('100.64.0.20')).toBeVisible();
  await expect(main.locator('.hz-status-label', { hasText: 'Neustart nötig' })).toBeVisible();
  await expect(main.getByLabel('Status-Gründe')).toContainText('Neustart nötig');
  await expect(main.getByRole('list', { name: 'Offene Ports' }).getByRole('listitem')).toHaveCount(
    2,
  );
  await themes('detail', true);

  await main.getByRole('button', { name: 'Aufräumen' }).click();
  const cleanup = page.getByRole('dialog', { name: 'heimserver aufräumen' });
  await expect(cleanup.getByRole('table')).toContainText('Ungenutzte Docker-Images');
  await expect(cleanup.getByRole('table')).toContainText('8,4 GB');
  await themes('cleanup');
  await cleanup.getByRole('button', { name: 'Aufräumen' }).click();
  await expect(cleanup.getByText('8,4 GB frei auf heimserver.')).toBeVisible();
  await cleanup.getByRole('button', { name: 'Fertig' }).click();

  await main.getByRole('button', { name: 'Neustart' }).click();
  const reboot = page.getByRole('dialog', { name: 'heimserver neu starten' });
  const confirm = reboot.getByRole('button', { name: 'Neustart' });
  await expect(confirm).toBeDisabled();
  await reboot.getByLabel('Servername').fill('heimserver');
  await expect(confirm).toBeEnabled();
  await themes('reboot');
  // Step-up is asked for; cancel it, nothing is sent to the agent.
  await confirm.click();
  const stepUp = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(reboot.getByRole('alert')).toContainText('Bestätigung mit Code nötig.');
  await reboot.getByRole('button', { name: 'Abbrechen' }).click();
});

test('stopped agent turns DOWN with a crit alert', async () => {
  const agent = agents[0];
  if (!agent?.serverId) throw new Error('first agent missing');
  const patch = await apiCall('PATCH', `/api/servers/${agent.serverId}`, {
    thresholds: { offlineAfterS: 30 },
  });
  expect(patch.status).toBe(200);

  await page.goto('/');
  await expect(serverRow('heimserver')).toBeVisible();
  const before = navigations;
  agent.disconnect();

  const row = serverRow('heimserver');
  await expect(row.getByText('Ausgefallen')).toBeAttached({ timeout: 100_000 });
  // Status with shape and text: DOWN row has the crit class and the reason as text.
  await expect(row).toHaveClass(/hz-srv-crit/);
  await expect(page.locator('.hz-page-title em')).toBeVisible();
  const alert = page.getByRole('main').getByRole('alert').filter({ hasText: 'heimserver' });
  await expect(alert.first()).toBeVisible({ timeout: 20_000 });
  // The same alert floats bottom right.
  await expect(page.locator('.app-toasts').getByRole('alert')).toContainText('heimserver');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toContainText(
    // Count of open alerts (warn ones for updates and reboot are open too).
    /Meldungen\s*[1-9]/,
  );
  expect(navigations).toBe(before);
  await themes('overview-down', true);

  await page.goto('/alerts');
  await expect(page.getByRole('listitem').filter({ hasText: 'heimserver' }).first()).toBeVisible();
  await themes('alerts');
});
