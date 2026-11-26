import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ORIGIN, signIn } from './helpers/auth.js';
import { SimAgent, hexId, imageId, type SimContainer } from './helpers/sim-agent.js';

/**
 * M3 acceptance (docs/ROADMAP.md): a container stopped from the UI turns OFF live and
 * raises a message, logs stream (follow, pause, search), and "Image aktualisieren"
 * sends the right agent action (compose pull + up for managed compose projects,
 * container.update for the rest) and the container runs with the new image.
 */

const SHOTS = 'docs/screenshots/m3';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const MB = 1024 ** 2;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let context: BrowserContext;
let page: Page;
let agent: SimAgent;
let navigations = 0;

function started(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function containers(): SimContainer[] {
  return [
    {
      dockerId: hexId(),
      name: 'homeassistant',
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      imageId: imageId(),
      composeProject: 'home',
      composeService: 'homeassistant',
      composeDir: '/opt/homelab/home',
      state: 'running',
      health: 'healthy',
      statusText: 'Up 41 days (healthy)',
      startedAt: started(41 * 24 * 60),
      ports: [{ privatePort: 8123, publicPort: 8123, ip: '0.0.0.0', proto: 'tcp' }],
      cpu: 3.4,
      memBytes: 612 * MB,
      restartCount: 0,
    },
    {
      dockerId: hexId(),
      name: 'mosquitto',
      image: 'eclipse-mosquitto:2',
      imageId: imageId(),
      composeProject: 'home',
      composeService: 'mosquitto',
      composeDir: '/opt/homelab/home',
      state: 'running',
      health: 'none',
      statusText: 'Up 41 days',
      startedAt: started(41 * 24 * 60),
      ports: [{ privatePort: 1883, publicPort: 1883, proto: 'tcp' }],
      cpu: 0.2,
      memBytes: 9 * MB,
    },
    {
      dockerId: hexId(),
      name: 'lernplattform',
      image: 'ghcr.io/puffybooy/lernplattform:main',
      imageId: imageId(),
      state: 'exited',
      health: 'none',
      statusText: 'Exited (1) 2 hours ago',
      exitCode: 1,
      ports: [],
    },
    {
      dockerId: hexId(),
      name: 'caddy',
      image: 'caddy:2.8',
      imageId: imageId(),
      state: 'running',
      health: 'none',
      statusText: 'Up 6 days',
      startedAt: started(6 * 24 * 60),
      ports: [
        { privatePort: 443, publicPort: 443, proto: 'tcp' },
        { privatePort: 80, publicPort: 80, proto: 'tcp' },
      ],
      cpu: 0.6,
      memBytes: 38 * MB,
    },
    {
      dockerId: hexId(),
      name: 'whoami',
      image: 'traefik/whoami:latest',
      imageId: imageId(),
      state: 'running',
      health: 'none',
      statusText: 'Up 3 hours',
      startedAt: started(3 * 60),
      ports: [{ privatePort: 80, publicPort: 8081, ip: '127.0.0.1', proto: 'tcp' }],
      cpu: 0,
      memBytes: 4 * MB,
    },
  ];
}

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

interface ApiContainer {
  id: string;
  name: string;
  dockerId: string;
  status: string;
  serverName: string;
}

async function listContainers(): Promise<ApiContainer[]> {
  const res = await apiCall<{ containers: ApiContainer[] }>('GET', '/api/containers');
  expect(res.status).toBe(200);
  return res.data.containers.filter((c) => c.serverName === agentName);
}

function row(name: string) {
  return page.locator('.hz-row').filter({ has: page.locator('.hz-row-name', { hasText: name }) });
}

/** Text of the shown log lines. */
function logLines() {
  return page.locator('.hz-term-line');
}

const agentName = 'heimserver-m3';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await signIn(page);

  const res = await apiCall<{ token: string }>('POST', '/api/servers/enroll', {
    name: agentName,
    location: 'Wien',
  });
  expect(res.status).toBe(200);
  agent = new SimAgent({
    url: AGENT_URL,
    name: agentName,
    token: res.data.token,
    containers: containers(),
    logEveryMs: 300,
  });
  await agent.connect();
});

test.afterAll(async () => {
  agent?.disconnect();
  await context.close();
});

test('container page: grouped by server and compose project, problems first', async () => {
  await page.goto('/containers');
  const tile = page.locator('.hz-tile').filter({ hasText: agentName });
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile.locator('.hz-row')).toHaveCount(5);

  // Statussatz names the problem first.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('lernplattform');

  // compose project first, standalone after; crit row comes first among standalone.
  const groups = tile.getByRole('group');
  await expect(groups.nth(0)).toHaveAccessibleName('einzeln');
  await expect(groups.nth(1)).toHaveAccessibleName('compose · home');
  const firstStandalone = groups.nth(0).locator('.hz-row').first();
  await expect(firstStandalone.locator('.hz-row-name')).toHaveText('lernplattform');
  // Status with shape and text.
  await expect(row('lernplattform').locator('.hz-status-label')).toHaveText('DOWN');
  await expect(row('lernplattform')).toContainText('exit 1');
  await expect(row('homeassistant').locator('.hz-status-label')).toHaveText('UP');
  await expect(row('homeassistant')).toContainText(':8123');
  await expect(row('homeassistant')).toContainText('RAM 612 MB');
  await expect(row('whoami')).toContainText('127.0.0.1:8081');

  // Every row action is a labelled ghost button, reachable with the keyboard.
  const logs = row('homeassistant').getByRole('button', { name: 'Logs von homeassistant' });
  await logs.focus();
  await expect(logs).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    row('homeassistant').getByRole('button', { name: 'homeassistant stoppen' }),
  ).toBeFocused();

  await page.evaluate('document.activeElement?.blur()');
  await themes('containers', true);

  // ServerSwitch filters the page.
  await page.getByRole('tab', { name: new RegExp(agentName) }).click();
  await expect(page).toHaveURL(/\?server=/);
  await expect(page.locator('.hz-tile').filter({ hasText: agentName })).toBeVisible();
});

test('stop: row turns OFF live and a message appears', async () => {
  await page.goto('/containers');
  await expect(row('whoami').locator('.hz-status-label')).toHaveText('UP');
  const before = navigations;

  await row('whoami').getByRole('button', { name: 'whoami stoppen' }).click();
  await expect(row('whoami').locator('.hz-status-label')).toHaveText('OFF', { timeout: 15_000 });
  await expect(row('whoami')).toContainText('exit 0');
  await expect(row('whoami').getByRole('button', { name: 'whoami starten' })).toBeVisible();
  expect(agent.rpcs.filter((r) => r.action === 'container.stop')).toEqual([
    { action: 'container.stop', params: { id: agent.container('whoami')?.dockerId } },
  ]);

  const messages = page.getByLabel('Meldungen zu Containern');
  await expect(messages).toContainText(`whoami auf ${agentName} gestoppt`, { timeout: 15_000 });
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toContainText(
    /Meldungen\s*[1-9]/,
  );
  expect(navigations).toBe(before);
  await themes('containers-stopped');

  // A stop from outside (agent inventory) arrives live as well.
  const mosq = agent.container('mosquitto');
  if (!mosq) throw new Error('mosquitto missing');
  mosq.state = 'exited';
  mosq.exitCode = 137;
  mosq.statusText = 'Exited (137) 1 second ago';
  agent.sendInventory();
  await expect(row('mosquitto').locator('.hz-status-label')).toHaveText('DOWN', {
    timeout: 15_000,
  });
  expect(navigations).toBe(before);

  // Start again so the overview below is calm apart from the planted problems.
  await row('whoami').getByRole('button', { name: 'whoami starten' }).click();
  await expect(row('whoami').locator('.hz-status-label')).toHaveText('UP', { timeout: 15_000 });
});

test('logs stream, follow, pause and search', async () => {
  await page.goto('/containers');
  await row('homeassistant').getByRole('button', { name: 'Logs von homeassistant' }).click();
  await expect(page).toHaveURL(/\/containers\/[A-Za-z0-9_-]+\/logs$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('homeassistant läuft.');

  await expect(logLines().filter({ hasText: 'homeassistant boot step 1: ok' })).toHaveCount(1, {
    timeout: 15_000,
  });
  // stderr as err line.
  await expect(page.locator('.hz-term-err')).toContainText('no timezone');
  // New lines keep coming and the box follows them.
  await expect(logLines().filter({ hasText: 'heartbeat 3' })).toHaveCount(1, { timeout: 15_000 });
  const body = page.locator('.hz-term-body');
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(30);
  await expect(page.getByRole('button', { name: 'Folgen' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // A line pushed by the agent right now shows up.
  agent.logLine('homeassistant', 'ERROR custom line from e2e', 'stderr');
  await expect(page.locator('.hz-term-err', { hasText: 'custom line from e2e' })).toBeVisible();

  // Pause: the view stops, new lines are counted.
  await page.getByRole('button', { name: 'Pause' }).click();
  const frozen = await logLines().count();
  await page.waitForTimeout(1200);
  expect(await logLines().count()).toBe(frozen);
  await expect(page.locator('.app-logstate')).toContainText(/pausiert · \d+ neue Zeile/);

  // Search marks matches without touching the DOM of the Terminal.
  const search = page.getByLabel('Suche im Log');
  await search.fill('boot step 1');
  await expect(page.locator('.app-logsearch-n')).toHaveText(/^\d+ Treffer$/);
  await search.press('Enter');
  await expect(page.locator('.app-logsearch-n')).toHaveText(/^1 von \d+$/);
  const marked: number = await page.evaluate(
    // Runs in the browser; the e2e tsconfig has no DOM types for CSS.highlights.
    "CSS.highlights.get('hz-log-current')?.size ?? 0",
  );
  expect(marked).toBe(1);
  await themes('logs', true);

  await search.fill('nichts-davon');
  await expect(page.locator('.app-logsearch-n')).toHaveText('kein Treffer');
  await search.fill('');

  // Weiter: the waiting lines come in and following starts again.
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect.poll(() => logLines().count()).toBeGreaterThan(frozen);
  await expect(page.locator('.app-logstate')).toContainText('folgt');

  // Scrolling up stops following.
  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Folgen' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('image update: compose pull + up for compose, container.update otherwise', async () => {
  await page.goto('/containers');
  const ha = agent.container('homeassistant');
  if (!ha) throw new Error('homeassistant missing');
  const oldImage = ha.imageId;

  await row('homeassistant')
    .getByRole('button', { name: 'Image von homeassistant aktualisieren' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'homeassistant aktualisieren' });
  await expect(dialog).toContainText('docker compose pull && up -d');
  await themes('update-confirm');
  const before = agent.rpcs.length;
  await dialog.getByRole('button', { name: 'Image aktualisieren' }).click();
  await expect(dialog.getByText('homeassistant läuft mit dem neuen Image.')).toBeVisible({
    timeout: 20_000,
  });
  await themes('update-done');
  expect(agent.rpcs.slice(before).map((r) => [r.action, r.params.dir])).toEqual([
    ['compose.pull', '/opt/homelab/home'],
    ['compose.up', '/opt/homelab/home'],
  ]);
  expect(agent.container('homeassistant')?.imageId).not.toBe(oldImage);
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(row('homeassistant').locator('.hz-status-label')).toHaveText('UP');
  // Recreated: the core follows the new docker id.
  const after = (await listContainers()).find((c) => c.name === 'homeassistant');
  expect(after?.dockerId).toBe(agent.container('homeassistant')?.dockerId);

  // Standalone container: container.update with its docker id.
  const caddyId = agent.container('caddy')?.dockerId;
  await row('caddy').getByRole('button', { name: 'Image von caddy aktualisieren' }).click();
  const d2 = page.getByRole('dialog', { name: 'caddy aktualisieren' });
  await expect(d2).toContainText('mit derselben Konfiguration neu');
  const mark = agent.rpcs.length;
  await d2.getByRole('button', { name: 'Image aktualisieren' }).click();
  await expect(d2.getByText('caddy läuft mit dem neuen Image.')).toBeVisible({ timeout: 20_000 });
  expect(agent.rpcs.slice(mark)).toEqual([{ action: 'container.update', params: { id: caddyId } }]);
  await d2.getByRole('button', { name: 'Fertig' }).click();
});

test('overview tile and server detail section', async () => {
  await page.goto('/');
  const tile = page.locator('.hz-tile').filter({
    has: page.locator('.hz-tile-title', { hasText: 'Container' }),
  });
  await expect(tile).toBeVisible();
  // compose up -d in the update above started mosquitto again; lernplattform stays down.
  await expect(tile.locator('.hz-tile-count')).toHaveText('4 von 5 laufen · 1 Problem');
  // Problems first.
  await expect(tile.locator('.hz-row-name').first()).toHaveText('lernplattform');
  await expect(tile.locator('.hz-row').first().locator('.hz-status-label')).toHaveText('DOWN');
  await themes('overview', true);

  await page.goto('/servers');
  await page.locator('.hz-srvlist').getByRole('listitem').filter({ hasText: agentName }).click();
  const section = page.locator('.hz-tile').filter({ hasText: 'Container dieses Servers' });
  await expect(section).toBeVisible();
  await expect(section.locator('.hz-row')).toHaveCount(5);
  await section.scrollIntoViewIfNeeded();
  await themes('server-detail');
});
