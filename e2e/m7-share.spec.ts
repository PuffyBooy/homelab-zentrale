import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { answerStepUp, ORIGIN, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M7 acceptance (docs/ROADMAP.md): a link with only "Starten/Stoppen" can start the
 * server but gets no console (also not by a direct request: 403), and a revoked link
 * shows "Link widerrufen" on the friend's page with the next poll. Runs against the real
 * core with a simulated agent that knows game servers.
 */

const SHOTS = 'docs/screenshots/m7';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
// Unique per run: a retried beforeAll must not hit the name of the first try (409).
const AGENT_NAME = `oracle-m7-${Date.now().toString(36)}`;
const GAME = 'survival';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let admin: BrowserContext;
let page: Page;
let friendCtx: BrowserContext;
let friend: Page;
let agent: SimAgent;
let totp: Totp;
let gameId = '';
let token = '';

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

/** fullPage: false for app pages, the sticky NavRail lands mid-page in full-page shots. */
async function shot(p: Page, name: string, fullPage = true): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await p.evaluate('document.fonts.ready');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/** dark, light (system preference) and wall (data-theme) like the other milestones. */
async function themes(p: Page, name: string, fullPage = true): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    await expect(p.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(p, `e2e-${name}-${scheme}`, fullPage);
  }
  await p.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(p, `e2e-${name}-wall`, fullPage);
  await p.emulateMedia({ colorScheme: 'dark' });
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark');
}

async function gameStatus(): Promise<string> {
  const t0 = Date.now();
  const res = await apiCall<{ games: { id: string; status: string; statusText: string }[] }>(
    'GET',
    '/api/games',
  );
  const g = res.data.games.find((x) => x.id === gameId);
  if (g && g.status !== 'ok' && g.status !== 'off')
    console.warn(`game ${g?.status ?? 'missing'}: ${g?.statusText ?? ''} (${Date.now() - t0} ms)`);
  return g?.status ?? 'missing';
}

async function newFriend(browser: Browser): Promise<void> {
  friendCtx = await browser.newContext({
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  friend = await friendCtx.newPage();
}

test.beforeAll(async ({ browser }) => {
  admin = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await admin.newPage();
  totp = await signIn(page);

  const enroll = await apiCall<{ token: string }>('POST', '/api/servers/enroll', {
    name: AGENT_NAME,
    location: 'Oracle Cloud',
  });
  expect(enroll.status).toBe(200);
  agent = new SimAgent({ url: AGENT_URL, name: AGENT_NAME, token: enroll.data.token, games: true });
  await agent.connect();

  const created = await apiCall<{ game: { id: string } }>('POST', '/api/games', {
    templateId: 'minecraft-java',
    serverId: agent.serverId,
    name: GAME,
    values: {},
    externalAddress: 'mc.example.at',
  });
  expect(created.status).toBe(202);
  gameId = created.data.game.id;
  // Setup: write, pull, up, then game.status every 5 s until online.
  await expect.poll(gameStatus, { timeout: 90_000, intervals: [1000] }).toBe('ok');
  const stop = await apiCall('POST', `/api/games/${gameId}/stop`);
  expect(stop.status).toBe(200);
  await expect.poll(gameStatus, { timeout: 15_000 }).toBe('off');
});

test.afterAll(async () => {
  agent?.disconnect();
  await friendCtx?.close();
  await admin.close();
});

test('Teilen on the tile creates a link with only Starten/Stoppen, shown once', async () => {
  await page.goto(`/games/${gameId}`);
  const tile = page.locator('.hz-tile').filter({ hasText: 'Benutzerlinks' });
  await expect(tile.getByText('Noch kein Link.')).toBeVisible();

  await page.locator('.hz-game').getByRole('button', { name: 'Teilen' }).click();
  const dialog = page.getByRole('dialog', { name: `${GAME} teilen` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Person')).toBeFocused();
  // Defaults: only Starten/Stoppen; the whitelist is offered for Minecraft Java.
  await expect(dialog.getByRole('switch', { name: 'Starten/Stoppen' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.getByRole('switch', { name: 'Konsole lesen' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(dialog.getByRole('switch', { name: 'Whitelist bearbeiten' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Link erstellen' }).click();
  await expect(dialog.getByText('Name der Person eingeben.')).toBeVisible();
  await dialog.getByLabel('Person').fill('Lena');
  await dialog.getByLabel('Läuft ab nach').selectOption('7d');
  await shot(page, 'e2e-share-create-dark', false);
  await dialog.getByRole('button', { name: 'Link erstellen' }).click();

  const done = page.getByRole('dialog', { name: 'Link für Lena' });
  await expect(done.getByText('Der Link wird nur jetzt angezeigt.')).toBeVisible();
  const url = (await done.locator('.app-copy-inline').last().textContent()) ?? '';
  const m = /\/s\/([A-Za-z0-9_-]{43})$/.exec(url.trim());
  expect(m, `share url: ${url}`).not.toBeNull();
  token = m?.[1] ?? '';
  await expect(done.getByText('Starten/Stoppen', { exact: true })).toBeVisible();
  await shot(page, 'e2e-share-created-dark', false);
  await done.getByRole('button', { name: 'Fertig' }).click();

  const row = tile.getByTestId('share-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Lena');
  await expect(row).toContainText('AKTIV');
  await expect(row).toContainText('ohne PIN · noch nie benutzt');
});

test('the friend page starts the server and shows no console', async ({ browser }) => {
  await newFriend(browser);
  await friend.goto(`${ORIGIN}/s/${token}`);
  await expect(friend.getByRole('heading', { level: 1 })).toHaveText(GAME);
  const game = friend.locator('.hz-game');
  await expect(game.locator('.hz-status')).toContainText('OFF');
  await expect(game.getByRole('button', { name: 'Neu starten' })).toHaveCount(0);
  await expect(friend.getByText('Konsole')).toHaveCount(0);
  await expect(friend.getByText('Whitelist')).toHaveCount(0);
  // No navigation, no links at all.
  await expect(friend.locator('a')).toHaveCount(0);
  await expect(friend.locator('.sh-foot')).toContainText('Benutzerlink für Lena');

  // Nothing leaves the origin, and the token is never in a request URL other than the page.
  const leaks: string[] = [];
  friend.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== ORIGIN || (u.pathname.includes(token) && r.resourceType() !== 'document')) {
      leaks.push(r.url());
    }
  });

  await game.getByRole('button', { name: 'Starten' }).click();
  await expect(game.getByRole('button', { name: 'Stoppen' })).toBeVisible({ timeout: 20_000 });
  // Started: BOOT until the game answers its status query, then UP.
  await expect(game.locator('.hz-status')).toContainText(/UP|BOOT/);
  expect(agent.rpcs.filter((r) => r.action === 'compose.up').length).toBeGreaterThan(1);
  await expect.poll(gameStatus, { timeout: 45_000, intervals: [1000] }).toBe('ok');
  await expect(game.locator('.hz-status')).toContainText('UP', { timeout: 20_000 });

  // Server side: the console needs console_read, a direct request is refused.
  const direct = await friend.evaluate(async (t) => {
    const res = await fetch('/s/api/console', { headers: { Authorization: `Share ${t}` } });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }, token);
  expect(direct.status).toBe(403);
  expect(direct.body.error).toBe('forbidden');
  const command = await friend.evaluate(async (t) => {
    const res = await fetch('/s/api/console', {
      method: 'POST',
      headers: { Authorization: `Share ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'op Lena' }),
    });
    return res.status;
  }, token);
  expect(command).toBe(403);
  expect(leaks).toEqual([]);

  await themes(friend, 'share-friend');
  await friend.setViewportSize({ width: 390, height: 844 });
  await shot(friend, 'e2e-share-friend-phone-dark');
  await friend.setViewportSize({ width: 1280, height: 900 });
});

test('admin sees the audit and the link in all themes', async () => {
  await page.reload();
  const audit = page.locator('.hz-tile').filter({ hasText: 'Wer hat was gemacht' });
  await expect(audit.getByText('Lena hat gestartet')).toBeVisible({ timeout: 35_000 });
  await expect(audit).toContainText('im Tailnet');
  await expect(audit.getByText('Lena wurde abgewiesen (kein Recht)').first()).toBeVisible();
  await page.locator('.hz-tile').filter({ hasText: 'Benutzerlinks' }).scrollIntoViewIfNeeded();
  await themes(page, 'share-admin', false);
});

test('a revoked link shows "Link widerrufen" with the next poll', async () => {
  const tile = page.locator('.hz-tile').filter({ hasText: 'Benutzerlinks' });
  await tile.getByRole('button', { name: 'Widerrufen' }).click();
  const confirm = page.getByRole('dialog', { name: 'Link von Lena widerrufen' });
  await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Widerrufen' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  if (await stepUp.isVisible().catch(() => false)) await answerStepUp(page, totp);
  await expect(tile.getByTestId('share-row')).toContainText('WIDERRUFEN');
  await expect(tile.getByRole('button', { name: 'Link von Lena entfernen' })).toBeVisible();

  // Immediately 410 for the API ...
  const status = await friend.evaluate(async (t) => {
    const res = await fetch('/s/api/status', { headers: { Authorization: `Share ${t}` } });
    return res.status;
  }, token);
  expect(status).toBe(410);
  // ... and the open page says so on its next status poll (every 15 s).
  await expect(friend.getByRole('heading', { level: 1 })).toHaveText('Link widerrufen.', {
    timeout: 25_000,
  });
  await expect(friend.locator('.hz-game')).toHaveCount(0);
  await themes(friend, 'share-friend-revoked');

  // Removing keeps the audit.
  await tile.getByRole('button', { name: 'Link von Lena entfernen' }).click();
  await expect(tile.getByText('Noch kein Link.')).toBeVisible();
  const audit = page.locator('.hz-tile').filter({ hasText: 'Wer hat was gemacht' });
  await expect(audit.getByText('Lena hat gestartet')).toBeVisible();
});

test('an unknown token says "Link ungültig" without any API request', async () => {
  const sent: string[] = [];
  friend.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/s/api/')) sent.push(r.url());
  });
  await friend.goto(`${ORIGIN}/s/kaputt`);
  await expect(friend.getByRole('heading', { level: 1 })).toHaveText('Link ungültig.');
  expect(sent).toEqual([]);
});
