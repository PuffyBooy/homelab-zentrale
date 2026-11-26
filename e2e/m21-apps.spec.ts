import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { enrollServer, ORIGIN, setModules, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M21 Apps (docs/ROADMAP.md) against the real core and a simulated agent:
 * - Module apps on, the catalog shows the built-in template Vaultwarden.
 * - Install dialog: "Vorschau" without problems, "Installieren": the agent gets
 *   compose.write (compose.yml + .env under /opt/homelab/apps/<id>) and compose.up,
 *   the app shows up under "Installierte Apps" as running.
 * Screenshots in test-results/screenshots/m21/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'test-results/screenshots/m21';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const SERVER = `heim-m21-${SUFFIX}`;
const APP_ID = `vault-${SUFFIX}`.slice(0, 32);
const APP_NAME = 'Passwörter';
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
  await setModules(page, totp, { apps: true });
  const enroll = await enrollServer(page, totp, SERVER, 'Keller');
  expect(enroll.status).toBe(200);
  agent = new SimAgent({
    url: AGENT_URL,
    name: SERVER,
    token: enroll.data.token,
    containers: [],
    apps: true,
    tailscaleIp: '100.64.0.21',
  });
  await agent.connect();
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
});

test('catalog shows Vaultwarden, preview without problems, install: the app shows up', async () => {
  await page.goto('/apps');
  const catalog = tileByTitle(page, 'Katalog');
  await expect(catalog).toBeVisible();
  const card = catalog.getByRole('button', { name: /Vaultwarden/ });
  await expect(card).toBeVisible();
  await shots(page, 'apps-katalog');
  await card.click();

  const dialog = page.getByRole('dialog', { name: 'Vaultwarden installieren' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Server').selectOption(agent.serverId ?? '');
  await dialog.getByLabel('Name', { exact: true }).fill(APP_NAME);
  await dialog.getByLabel('App-Ordner').fill(APP_ID);
  await dialog.getByLabel(/^Adresse mit https/).fill('https://vault.example.ts.net');
  await dialog.getByRole('button', { name: 'Vorschau', exact: true }).click();
  await expect(dialog.getByText('Vorschau ohne Probleme.')).toBeVisible();
  await expect(dialog.getByText('compose.yml', { exact: true })).toBeVisible();
  await shots(page, 'apps-vorschau');

  await dialog.getByRole('button', { name: 'Installieren', exact: true }).click();
  await expect(dialog).toBeHidden();

  const dir = `/opt/homelab/apps/${APP_ID}`;
  await expect.poll(() => agent.rpcs.map((r) => r.action).join(',')).toContain('compose.up');
  const write = agent.rpcs.find((r) => r.action === 'compose.write');
  expect(write?.params.dir).toBe(dir);
  const files = agent.writtenFiles.get(dir) ?? {};
  expect(Object.keys(files).sort()).toEqual(['.env', 'compose.yml']);
  expect(String(files['compose.yml'])).toContain('vaultwarden/server:');
  expect(String(files['.env'])).toContain('100.64.0.21');
  expect(agent.rpcs.find((r) => r.action === 'compose.up')?.params.dir).toBe(dir);

  const installed = tileByTitle(page, 'Installierte Apps');
  const row = installed.locator('.hz-row', { hasText: APP_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('läuft', { timeout: 15_000 });
  await expect(installed.getByRole('button', { name: `${APP_NAME} stoppen` })).toBeVisible();
  await shots(page, 'apps-installiert');
});

test('no serious axe findings', () => {
  expect(findings).toEqual([]);
});
