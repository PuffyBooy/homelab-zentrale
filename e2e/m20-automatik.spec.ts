import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { enrollServer, ORIGIN, setModules, signIn, type Totp } from './helpers/auth.js';
import { hexId, imageId, SimAgent } from './helpers/sim-agent.js';

/**
 * M20 Automatik und Internet (docs/ROADMAP.md) against the real core and a simulated agent:
 * - Modules tasks and speedtest on (tasks needs step-up).
 * - "Aufgabe anlegen" with "Container neu starten" for a sim container, "Jetzt ausführen":
 *   the agent gets container.restart, the run shows up as OK.
 * - The page Internet shows the tile "Speedtest".
 * Screenshots in test-results/screenshots/m20/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'test-results/screenshots/m20';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const SERVER = `heim-m20-${SUFFIX}`;
const CONTAINER = 'nextcloud';
const TASK = 'Nextcloud nachts neu starten';
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
const findings: string[] = [];

function tileByTitle(p: Page, title: string): Locator {
  return p.locator(`section.hz-tile:has(.hz-tile-title > span:text-is("${title}"))`);
}

async function setTheme(p: Page, theme: Theme): Promise<void> {
  await p.emulateMedia({ colorScheme: theme === 'wall' ? 'dark' : theme });
  await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await p.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
  await p.waitForTimeout(100);
  await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
}

async function shots(p: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(p, theme);
    await p.evaluate('document.fonts.ready');
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
    const res = await new AxeBuilder({ page: p })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of res.violations) {
      if (v.impact === 'serious' || v.impact === 'critical') {
        findings.push(`${name}/${theme}: ${v.id} (${v.nodes.length})`);
      }
    }
  }
  await setTheme(p, 'dark');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  await setModules(page, totp, { tasks: true, speedtest: true });
  const enroll = await enrollServer(page, totp, SERVER, 'Keller');
  expect(enroll.status).toBe(200);
  agent = new SimAgent({
    url: AGENT_URL,
    name: SERVER,
    token: enroll.data.token,
    containers: [
      {
        dockerId: hexId(),
        name: CONTAINER,
        image: 'nextcloud:30-apache',
        imageId: imageId(),
        composeProject: 'nextcloud',
        composeService: 'app',
        composeDir: '/opt/stacks/nextcloud',
        state: 'running',
        health: 'healthy',
        statusText: 'Up 3 days (healthy)',
        startedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
        ports: [{ privatePort: 80, publicPort: 8080, proto: 'tcp' }],
        cpu: 2.1,
        memBytes: 412 * 1024 ** 2,
      },
    ],
  });
  await agent.connect();
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
});

test('task "Container neu starten": create, run now, the run is OK', async () => {
  await page.goto('/automation');
  const tile = tileByTitle(page, 'Geplante Aufgaben');
  await expect(tile).toBeVisible();
  await tile.getByRole('button', { name: 'Aufgabe anlegen' }).click();

  const dialog = page.getByRole('dialog', { name: 'Aufgabe anlegen' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Server').selectOption(agent.serverId ?? '');
  await dialog.getByLabel('Art', { exact: true }).selectOption({ label: 'Container neu starten' });
  const ctr = dialog.getByLabel('Container', { exact: true });
  await expect(ctr.locator('option', { hasText: CONTAINER })).toHaveCount(1);
  await ctr.selectOption(CONTAINER);
  await dialog.getByLabel('Name', { exact: true }).fill(TASK);
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(tile.getByText(TASK, { exact: true })).toBeVisible();
  await expect(tile.getByText(`${SERVER} · Container neu starten · ${CONTAINER}`)).toBeVisible();

  await tile.getByRole('button', { name: `${TASK} jetzt ausführen` }).click();
  await expect
    .poll(() => agent.rpcs.filter((r) => r.action === 'container.restart').length)
    .toBe(1);
  const restart = agent.rpcs.find((r) => r.action === 'container.restart');
  expect([CONTAINER, agent.container(CONTAINER)?.dockerId]).toContain(restart?.params.id);

  await tile.getByRole('button', { name: `Läufe von ${TASK}` }).click();
  const runs = page.getByRole('dialog', { name: `Läufe von ${TASK}` });
  await expect(runs).toBeVisible();
  const detail = runs.getByTestId('run-detail');
  await expect(detail.locator('dt:text-is("Status") + dd')).toHaveText('OK', { timeout: 15_000 });
  await expect(detail.locator('dt:text-is("Auslöser") + dd')).toHaveText('von Hand');
  await expect(runs.locator('.hz-row-sub').first()).toContainText('OK');
  await shots(page, 'automatik-laeufe');
  await runs.getByRole('button', { name: 'Schließen' }).click();
  await expect(runs).toBeHidden();

  await expect(tile.getByTestId('task-meta')).toContainText('OK', { timeout: 35_000 });
  await shots(page, 'automatik');
});

test('Internet shows the speedtest tile', async () => {
  await page.goto('/internet');
  const tile = tileByTitle(page, 'Speedtest');
  await expect(tile).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Jetzt messen' })).toBeVisible();
  await shots(page, 'internet');
});

test('no serious axe findings', () => {
  expect(findings).toEqual([]);
});
