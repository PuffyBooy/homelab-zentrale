import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  answerStepUpIfAsked,
  enrollServer,
  ORIGIN,
  pageFetch,
  setModules,
  signIn,
  type Totp,
} from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M11 (docs/ROADMAP.md) through the web UI against the real core and simulated agents:
 * - "Server hinzufügen" shows a code XXXX-XXXX and the one-liner; the test plays
 *   install.sh (POST /api/onboarding/exchange with the code, then a sim agent with the
 *   returned token) and the dialog switches to "Verbunden" with a link. The code works
 *   only once; GET /install.sh contains neither the code nor the token.
 * - Port audit: the first inventory seeds the allowed list (no alert); a new public
 *   port 8081 (nginx) shows up in "Offene Ports" and as a warn alert "Neuer offener Port
 *   8081 (nginx)"; "Erlauben" on the alerts page resolves it and adds it to the list.
 * - A game server moves from the first sim server to the onboarded one: "Umziehen …",
 *   suggestion, step-up, progress until done; afterwards it runs on the target.
 * Not covered here (core tests): code expiry after 15 Min, the brute-force limit,
 * cancel and rollback of a migration, failure texts.
 * Screenshots in docs/screenshots/m11/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m11';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const HOME = `heimserver-m11-${SUFFIX}`;
const NEW = `pi-m11-${SUFFIX}`;
const GAME = `welt-${SUFFIX.slice(-4)}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];
const GB = 1024 ** 3;

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let home: SimAgent;
let fresh: SimAgent | null = null;
let homeId = '';
let newId = '';
let gameId = '';
const findings: string[] = [];

function tileByTitle(p: Page, title: string): Locator {
  return p.locator(`section.hz-tile:has(.hz-tile-title > span:text-is("${title}"))`);
}

async function api<T>(method: string, path: string, body?: unknown) {
  return pageFetch<T>(page, method, path, body);
}

async function setTheme(p: Page, theme: Theme): Promise<void> {
  await p.emulateMedia({ colorScheme: theme === 'wall' ? 'dark' : theme });
  await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await p.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
  await p.waitForTimeout(100);
  await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Viewport shots; `focus` is scrolled into view first. */
async function shots(p: Page, name: string, focus?: Locator): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(p, theme);
    await p.evaluate('document.fonts.ready');
    if (focus) await focus.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
    const res = await new AxeBuilder({ page: p })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of res.violations) {
      if (v.impact !== 'serious' && v.impact !== 'critical') continue;
      findings.push(
        `${name} [${theme}]: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      );
    }
  }
  await setTheme(p, 'dark');
}

/** What install.sh does with the code: exchange it (no session, no Origin). */
async function exchange(code: string): Promise<Response> {
  return fetch(`${ORIGIN}/api/onboarding/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.trim().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  const enroll = await enrollServer(page, totp, HOME, 'Zuhause');
  expect(enroll.status).toBe(200);
  await setModules(page, totp, { games: true });
  home = new SimAgent({
    url: AGENT_URL,
    name: HOME,
    token: enroll.data.token,
    containers: [],
    games: true,
    ramUsed: 7.8 * GB,
    ramTotal: 16 * GB,
  });
  await home.connect();
  homeId = home.serverId ?? '';
});

test.afterAll(async () => {
  home?.disconnect();
  fresh?.disconnect();
  await context?.close();
});

test('Server hinzufügen: code and one-liner, the agent connects with the code only', async () => {
  await page.goto('/servers');
  await page.getByRole('button', { name: 'Server hinzufügen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Server hinzufügen' });
  await dialog.getByLabel('Name').fill(NEW);
  await dialog.getByLabel('Ort').fill('Garage');
  await dialog.getByRole('button', { name: 'Code erzeugen' }).click();
  await answerStepUpIfAsked(page, totp);

  const step = dialog.getByTestId('onboarding');
  await expect(step).toHaveAttribute('data-state', 'waiting');
  await expect(step).toContainText('Wartet auf den Server …');
  await expect(step).toContainText('Braucht Docker und Tailscale am neuen Server.');
  await expect(step).toContainText(/noch 1[45]:\d\d/);
  const code = (await step.locator('.hz-metric-value .hz-num').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const oneLiner = (await step.locator('pre.app-copy-code').textContent())?.trim() ?? '';
  expect(oneLiner).toMatch(/^curl -fsSL \S+\/install\.sh \| sudo sh -s -- /);
  expect(oneLiner.endsWith(code)).toBe(true);
  await shots(page, 'onboarding-code', dialog);

  // install.sh is the same for every server: no code, no token.
  const script = await fetch(`${ORIGIN}/install.sh`);
  expect(script.status).toBe(200);
  const body = await script.text();
  expect(body).not.toContain(code);
  expect(body).not.toContain(code.replace('-', ''));

  const ex = await exchange(code.toLowerCase());
  expect(ex.status).toBe(200);
  const env = parseEnv(await ex.text());
  expect(env.HZ_AGENT_NAME).toBe(NEW);
  expect(env.HZ_CORE_URL).toMatch(/\/agent$/);
  expect(env.HZ_AGENT_TOKEN).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
  expect(env.HZ_AGENT_IMAGE).toBeTruthy();
  // One-time: the same code again gets the fixed refusal.
  const again = await exchange(code);
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ error: 'invalid_credentials' });

  await expect(step).toHaveAttribute('data-state', 'installing', { timeout: 10_000 });
  await expect(step).toContainText('Installiert …');

  fresh = new SimAgent({
    url: AGENT_URL,
    name: NEW,
    token: env.HZ_AGENT_TOKEN ?? '',
    containers: [],
    games: true,
    ramUsed: 2 * GB,
    ramTotal: 16 * GB,
    tailscaleIp: '100.64.0.31',
  });
  await fresh.connect();
  newId = fresh.serverId ?? '';
  await expect(step).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });
  await expect(step).toContainText('Verbunden');
  const open = step.getByRole('button', { name: 'Server öffnen' });
  await expect(open).toBeVisible();
  await shots(page, 'onboarding-connected', dialog);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/servers/${newId}$`));
});

test('Abbrechen cancels an open code', async () => {
  await page.goto('/servers');
  await page.getByRole('button', { name: 'Server hinzufügen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Server hinzufügen' });
  await dialog.getByLabel('Name').fill(`nie-${SUFFIX}`);
  await dialog.getByRole('button', { name: 'Code erzeugen' }).click();
  await answerStepUpIfAsked(page, totp);
  const step = dialog.getByTestId('onboarding');
  const code = (await step.locator('.hz-metric-value .hz-num').textContent())?.trim() ?? '';
  await step.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await exchange(code)).status).toBe(400);
});

test('port audit: seeded list, new port 8081 alerts, Erlauben resolves it', async () => {
  const seeded = await api<{ seeded: boolean; allowed: { port: number }[] }>(
    'GET',
    `/api/servers/${homeId}/ports/allowed`,
  );
  expect(seeded.data.seeded).toBe(true);
  expect(seeded.data.allowed.map((p) => p.port)).toEqual([22]);

  home.listen({ proto: 'tcp', address: '0.0.0.0', port: 8081, process: 'nginx' });
  const findAlert = async (): Promise<{ id: string; title: string; state: string } | undefined> => {
    const r = await api<{ alerts: { id: string; key: string; title: string; state: string }[] }>(
      'GET',
      '/api/alerts?state=all&limit=200',
    );
    return r.data.alerts.find((a) => a.key === `port:${homeId}:tcp:8081`);
  };
  await expect.poll(async () => (await findAlert())?.title).toBe('Neuer offener Port 8081 (nginx)');

  await page.goto(`/servers/${homeId}`);
  const tile = tileByTitle(page, 'Offene Ports');
  await expect(tile).toContainText('1 Port nicht erlaubt');
  const row = tile.locator('li.hz-row', { hasText: '8081/tcp' });
  await expect(row).toContainText('nicht erlaubt');
  await expect(row).toContainText('nginx · 0.0.0.0');
  await expect(row.getByRole('button', { name: '8081/tcp erlauben' })).toBeVisible();
  await shots(page, 'server-open-ports', tile);

  await page.goto('/alerts');
  const line = page.getByTestId('alert-line').filter({ hasText: 'Neuer offener Port 8081' });
  await expect(line).toBeVisible();
  await shots(page, 'alerts-port', line);
  await line.getByRole('button', { name: 'Port 8081/tcp erlauben' }).click();
  await expect.poll(async () => (await findAlert())?.state).toBe('resolved');
  const after = await api<{ allowed: { port: number; proto: string }[] }>(
    'GET',
    `/api/servers/${homeId}/ports/allowed`,
  );
  expect(after.data.allowed).toEqual(
    expect.arrayContaining([expect.objectContaining({ port: 8081, proto: 'tcp' })]),
  );

  // Edit the list by hand: a note for 8081.
  await page.goto(`/servers/${homeId}`);
  await expect(tile).toContainText(/alle 2 erlaubt/);
  await tile.getByRole('button', { name: 'Bearbeiten' }).click();
  const form = tile.getByRole('form', { name: 'Erlaubte Ports bearbeiten' });
  await form.getByLabel('Notiz').nth(1).fill('nginx Testseite');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(tile.getByRole('list', { name: 'Erlaubte Ports' })).toContainText('nginx Testseite');
});

test('a game server moves to the onboarded server and runs there', async () => {
  expect(newId).not.toBe('');
  const created = await api<{ game: { id: string } }>('POST', '/api/games', {
    templateId: 'minecraft-java',
    serverId: homeId,
    name: GAME,
    values: {},
    externalAddress: 'mc.example.at',
  });
  expect(created.status).toBe(202);
  gameId = created.data.game.id;
  const current = async () => {
    const r = await api<{ games: { id: string; status: string; serverId: string }[] }>(
      'GET',
      '/api/games',
    );
    return r.data.games.find((g) => g.id === gameId);
  };
  await expect.poll(async () => (await current())?.status, { timeout: 120_000 }).toBe('ok');

  await page.goto(`/games/${gameId}`);
  await tileByTitle(page, 'Umziehen').getByRole('button', { name: 'Umziehen …' }).click();
  const dialog = page.getByRole('dialog', { name: `${GAME} umziehen` });
  await expect(dialog).toContainText(`Die Zentrale speichert und stoppt ${GAME} auf`);
  const select = dialog.getByLabel('Zielserver');
  await expect(select.locator('option', { hasText: HOME })).toHaveCount(0);
  await select.selectOption(newId);
  const suggest = dialog.getByTestId('migrate-suggest');
  await expect(suggest).toContainText('Ports am Ziel');
  await expect(suggest).toContainText(`auf ${NEW}`);
  await shots(page, 'game-migrate-dialog', dialog);

  await dialog.getByRole('button', { name: `Nach ${NEW} umziehen` }).click();
  // Moving needs step-up (it may still be active from the code above).
  await answerStepUpIfAsked(page, totp);
  await expect(dialog).toHaveCount(0);

  const progress = page.getByTestId('migration');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('data-phase', 'done', { timeout: 120_000 });
  await expect(progress).toContainText(`${GAME} läuft jetzt auf ${NEW}.`);
  await expect.poll(async () => (await current())?.serverId).toBe(newId);
  await expect.poll(async () => (await current())?.status, { timeout: 60_000 }).toBe('ok');
  expect(home.rpcs.some((r) => r.action === 'game.export')).toBe(true);
  expect(fresh?.rpcs.some((r) => r.action === 'game.import')).toBe(true);
  expect(fresh?.gameData.get(GAME)).toEqual(home.gameData.get(GAME));
  // The source was stopped and keeps its folder.
  expect(home.rpcs.some((r) => r.action === 'compose.down')).toBe(true);
  await shots(page, 'game-migrated', tileByTitle(page, `Umzug nach ${NEW}`));
});

test('no serious or critical axe findings on the M11 screens', () => {
  expect(findings).toEqual([]);
});
