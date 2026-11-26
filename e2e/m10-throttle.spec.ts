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
import { hexId, imageId, SimAgent, type SimContainer } from './helpers/sim-agent.js';

/**
 * M10 (docs/ROADMAP.md, SPEC 6a) through the web UI against the real core and a
 * simulated agent:
 * - "Wer frisst gerade?" lists the top consumers; the core container (hz.role) has no
 *   buttons; "Stoppen" asks first and only the confirmation sends container.stop.
 * - Container detail: priority niedrig + "darf gestoppt werden", manual "Drosseln …"
 *   with the 0,1–64 bound (agent gets container.limit), "Drosselung aufheben".
 * - The list shows "gedrosselt (1,5 Kerne)".
 * - Server "Automatik": RAM reserve and a schedule window are saved.
 * - A game server that does not fit into free RAM minus reserve does not start:
 *   "Zu wenig RAM, 4,2 GB frei" (sim: 16 GB total, 7,8 GB used, reserve 4 GB).
 * The rule set itself (throttle after 2 Min, stop after 5 Min, windows) runs on core
 * time and is covered by the core tests with a fake clock.
 * Screenshots in docs/screenshots/m10/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m10';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const NAME = `heimserver-m10-${Date.now().toString(36)}`;
const GAME = `welt-${Date.now().toString(36).slice(-4)}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];
const MB = 1024 ** 2;

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
let serverId = '';
let gameId = '';
const ids: Record<string, string> = {};
const findings: string[] = [];

/** A tile by its exact title (the title span of Tile). */
function tileByTitle(p: Page, title: string) {
  return p.locator(`section.hz-tile:has(.hz-tile-title > span:text-is("${title}"))`);
}

function containers(): SimContainer[] {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const c = (name: string, over: Partial<SimContainer>): SimContainer => ({
    dockerId: hexId(),
    name,
    image: `${name}:e2e`,
    imageId: imageId(),
    state: 'running',
    health: 'none',
    statusText: 'Up 3 days',
    startedAt: since,
    ports: [],
    ...over,
  });
  return [
    c('cruncher', { cpu: 88.4, memBytes: 1200 * MB }),
    c('hz-core', {
      image: 'ghcr.io/homelab-zentrale/core:e2e',
      role: 'core',
      cpu: 41,
      memBytes: 180 * MB,
    }),
    c('my-app', { cpu: 12.5, memBytes: 2500 * MB }),
    c('jellyfin', { cpu: 3.1, memBytes: 3100 * MB }),
  ];
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

/** Viewport shots (the nav rail is sticky); `focus` is scrolled into view first. */
async function shots(p: Page, name: string, focus?: Locator): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(p, theme);
    await p.evaluate('document.fonts.ready');
    if (focus) await focus.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
    await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
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

function rpcs(action: string): Record<string, unknown>[] {
  return agent.rpcs.filter((r) => r.action === action).map((r) => r.params);
}

test.beforeAll(async ({ browser }) => {
  // Hooks default to 30 s; signIn and the step-up may each wait ~26 s for a fresh TOTP
  // window, then the game setup polls up to 120 s.
  test.setTimeout(240_000);
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  const enroll = await enrollServer(page, totp, NAME, 'Zuhause');
  expect(enroll.status).toBe(200);
  await setModules(page, totp, { games: true });
  agent = new SimAgent({
    url: AGENT_URL,
    name: NAME,
    token: enroll.data.token,
    containers: containers(),
    games: true,
    ramUsed: 7.8 * 1024 ** 3,
    ramTotal: 16 * 1024 ** 3,
  });
  await agent.connect();
  serverId = agent.serverId ?? '';

  await expect
    .poll(async () => {
      const r = await api<{ containers: { id: string; name: string; serverId: string }[] }>(
        'GET',
        '/api/containers',
      );
      for (const c of r.data.containers) if (c.serverId === serverId) ids[c.name] = c.id;
      return Object.keys(ids).length;
    })
    .toBe(4);
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
});

test('"Wer frisst gerade?": protected without buttons, Stoppen asks first', async () => {
  await page.goto(`/?server=${encodeURIComponent(serverId)}`);
  const tile = tileByTitle(page, 'Wer frisst gerade?');
  await expect(tile).toBeVisible();
  const cpu = tile.getByRole('region', { name: 'CPU' });
  await expect(cpu.locator('.hz-row').first()).toContainText('cruncher');
  await expect(cpu).toContainText('CPU 88 %');
  await expect(cpu).toContainText('Zentrale/Agent');
  await expect(tile.getByRole('button', { name: 'hz-core stoppen' })).toHaveCount(0);
  await expect(tile.getByRole('button', { name: 'hz-core drosseln' })).toHaveCount(0);
  await expect(tile.getByRole('region', { name: 'RAM' }).locator('.hz-row').first()).toContainText(
    'jellyfin',
  );

  await shots(page, 'overview-top-consumers');

  await cpu.getByRole('button', { name: 'cruncher stoppen' }).click();
  const dialog = page.getByRole('dialog', { name: 'cruncher stoppen?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`cruncher auf ${NAME} wird gestoppt`);
  await shots(page, 'overview-stop-confirm');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  expect(rpcs('container.stop')).toEqual([]);
});

test('container detail: priority niedrig, manual throttle 0,1–64 and lift', async () => {
  await page.goto(`/containers/${ids.cruncher}/logs`);
  const prio = tileByTitle(page, 'Priorität');
  await prio.getByLabel('Priorität').selectOption('niedrig');
  await prio.getByRole('switch', { name: 'darf gestoppt werden' }).click();
  await prio.getByRole('button', { name: 'Speichern' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(prio.getByText('Priorität gespeichert.')).toBeVisible();
  const saved = await api<{ priority: string; allowStop: boolean }>(
    'GET',
    `/api/containers/${ids.cruncher}/priority`,
  );
  expect(saved.data).toMatchObject({ priority: 'niedrig', allowStop: true });

  const thr = tileByTitle(page, 'Drosselung');
  await thr.getByRole('button', { name: 'Drosseln …' }).click();
  const dialog = page.getByRole('dialog', { name: 'cruncher drosseln' });
  const input = dialog.getByLabel('CPU-Anteil (Kerne)');
  await input.fill('65');
  await dialog.getByRole('button', { name: 'Drosseln' }).click();
  await expect(dialog.getByText('Zahl von 0,1 bis 64.')).toBeVisible();
  expect(rpcs('container.limit')).toEqual([]);
  await input.fill('1,5');
  await dialog.getByRole('button', { name: 'Drosseln' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => rpcs('container.limit').map((p) => p.cpus)).toEqual([1.5]);
  await expect(thr).toContainText('gedrosselt auf 1,5 Kerne');
  await shots(page, 'container-detail-throttled', tileByTitle(page, 'Priorität'));

  await page.goto(`/containers?server=${encodeURIComponent(serverId)}`);
  await expect(page.locator('.hz-row', { hasText: 'cruncher' })).toContainText(
    'gedrosselt (1,5 Kerne)',
  );
  await shots(page, 'containers-throttled');

  await page.goto(`/containers/${ids.cruncher}/logs`);
  await thr.getByRole('button', { name: 'Drosselung aufheben' }).click();
  await expect.poll(() => rpcs('container.limit').map((p) => p.cpus)).toEqual([1.5, null]);
  await expect(thr).toContainText('nicht gedrosselt');
});

test('the core container is always wichtig and read only', async () => {
  await page.goto(`/containers/${ids['hz-core']}/logs`);
  await expect(page.getByText('Zentrale/Agent: immer wichtig')).toBeVisible();
  await expect(page.getByLabel('Priorität')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Drosseln/ })).toHaveCount(0);
  // The core refuses it as well.
  const put = await api('PUT', `/api/containers/${ids['hz-core']}/priority`, {
    priority: 'niedrig',
    allowStop: true,
  });
  expect(put.status).toBe(403);
  const thr = await api('POST', `/api/containers/${ids['hz-core']}/throttle`, { cpus: 1 });
  expect(thr.status).toBe(403);
  expect(rpcs('container.limit')).toHaveLength(2);
});

test('server Automatik: RAM reserve and a schedule window are saved', async () => {
  await page.goto(`/servers/${serverId}#automatik`);
  const tile = page.locator('#automatik');
  await expect(tile).toContainText('Zeitzone: Europe/Vienna');
  await expect(tile).toContainText('RAM frei 8,2 GB');
  await tile.getByLabel('RAM-Reserve (GB)').fill('4');
  await tile.getByRole('button', { name: 'Zeitfenster hinzufügen' }).click();
  const win = tile.getByRole('group', { name: 'Zeitfenster 1' });
  await expect(win.getByRole('button', { name: 'Mo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await win.getByRole('button', { name: 'Sa', exact: true }).click();
  await win.getByLabel('Modus').selectOption('cpus');
  await win.getByLabel('Kerne').fill('2');
  await tile.getByRole('button', { name: 'Speichern' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(tile.getByText('Automatik gespeichert.')).toBeVisible();
  const r = await api<{
    settings: { ramReserveMb: number };
    schedules: { days: string[]; mode: string; cpus?: number }[];
  }>('GET', `/api/servers/${serverId}/throttle`);
  expect(r.data.settings.ramReserveMb).toBe(4096);
  expect(r.data.schedules).toEqual([
    {
      tier: 'niedrig',
      days: ['mo', 'di', 'mi', 'do', 'fr', 'sa'],
      from: '18:00',
      to: '23:00',
      mode: 'cpus',
      cpus: 2,
    },
  ]);
  await shots(page, 'server-automatik', tile);
});

test('a game server without room does not start: "Zu wenig RAM, X GB frei"', async () => {
  // Reserve back to 0 for the setup, which starts the game once.
  expect(
    (await api('PUT', `/api/servers/${serverId}/throttle`, { settings: { ramReserveMb: 0 } }))
      .status,
  ).toBe(200);
  const game = await api<{ game: { id: string } }>('POST', '/api/games', {
    templateId: 'minecraft-java',
    serverId,
    name: GAME,
    values: {},
    externalAddress: 'mc.example.at',
  });
  expect(game.status).toBe(202);
  gameId = game.data.game.id;
  const status = async (): Promise<string | undefined> => {
    const r = await api<{ games: { id: string; status: string }[] }>('GET', '/api/games');
    return r.data.games.find((g) => g.id === gameId)?.status;
  };
  await expect.poll(status, { timeout: 120_000, intervals: [1000] }).toBe('ok');
  expect((await api('POST', `/api/games/${gameId}/stop`, {})).status).toBeLessThan(300);
  await expect.poll(status, { timeout: 30_000 }).toBe('off');

  // 8,2 GB free minus 4 GB reserve = 4,2 GB < 6 GB (template recommendation).
  expect(
    (await api('PUT', `/api/servers/${serverId}/throttle`, { settings: { ramReserveMb: 4096 } }))
      .status,
  ).toBe(200);
  await page.goto(`/games/${gameId}`);
  await page.locator('.app-game').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Zu wenig RAM' })).toHaveText(
    /Zu wenig RAM, 4,2 GB frei/,
  );
  await expect.poll(status).toBe('off');

  const prio = tileByTitle(page, 'Priorität');
  await expect(prio.getByRole('switch', { name: 'auch mit Spielern online' })).toBeDisabled();
  await shots(page, 'game-insufficient-ram', page.locator('.app-game'));
});

test('Stoppen from the tile stops only after the confirmation', async () => {
  await page.goto(`/?server=${encodeURIComponent(serverId)}`);
  const tile = tileByTitle(page, 'Wer frisst gerade?');
  await tile
    .getByRole('region', { name: 'CPU' })
    .getByRole('button', { name: 'cruncher stoppen' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'cruncher stoppen?' });
  await dialog.getByRole('button', { name: 'Stoppen' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => rpcs('container.stop').length).toBe(1);
  await expect.poll(() => agent.container('cruncher')?.state).toBe('exited');
});

test('no serious or critical axe findings on the M10 screens', () => {
  expect(findings).toEqual([]);
});
