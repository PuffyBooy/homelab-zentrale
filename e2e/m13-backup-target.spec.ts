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
  stepUpCall,
  type Totp,
} from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M13b NAS als Backup-Ziel (docs/ROADMAP.md) against the real core and a simulated
 * home server with the NAS share mounted at /opt/homelab/backup-target:
 * - Settings → Backup: switch on, pick the server and the database target, save with step-up.
 * - "Jetzt kopieren": the core asks the agent, sends a real database snapshot
 *   (backup.target.store), the tile shows "Eingebunden (cifs)" and the database copy.
 * - The share drops: the next run writes nothing, the row shows WARN and a warning
 *   "Backup-Ziel auf … ist nicht eingebunden" opens.
 * Screenshots in docs/screenshots/m13b/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m13b';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const HOME = `heim-m13b-${SUFFIX}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let home: SimAgent;
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

async function shots(p: Page, name: string, focus: Locator): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(p, theme);
    await p.evaluate('document.fonts.ready');
    await focus.evaluate((el) => el.scrollIntoView({ block: 'start' }));
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
    locale: 'de-AT',
    viewport: { width: 1280, height: 1000 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  await setModules(page, totp, { storage: true });
  const enroll = await enrollServer(page, totp, HOME, 'Keller');
  expect(enroll.status).toBe(200);
  home = new SimAgent({
    url: AGENT_URL,
    name: HOME,
    token: enroll.data.token,
    containers: [],
    backupTarget: 'mounted',
  });
  await home.connect();
});

test.afterAll(async () => {
  // Leave the shared core as it was: no nightly runs against a gone sim agent.
  await stepUpCall(page, totp, 'PUT', '/api/storage/backup-target', {
    enabled: false,
    serverIds: [],
    dbServerId: null,
    keep: 14,
    time: '05:00',
  }).catch(() => undefined);
  home?.disconnect();
  await context?.close();
});

test('switch on, save with step-up, copy now: the database lands on the share', async () => {
  await page.goto('/settings#backup');
  const tile = tileByTitle(page, 'NAS als Backup-Ziel');
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.getByRole('switch', { name: 'Nachts aufs NAS kopieren' }).click();
  await tile.getByRole('switch', { name: `Gameserver-Backups von ${HOME}` }).click();
  await tile.getByRole('switch', { name: `Datenbank-Kopie auf ${HOME}` }).click();
  await tile.getByRole('button', { name: 'Speichern' }).click();
  // The session may still have step-up from enrolling the server in beforeAll.
  await answerStepUpIfAsked(page, totp);
  await expect(tile.getByText('Gespeichert.')).toBeVisible({ timeout: 15_000 });

  await tile.getByRole('button', { name: 'Jetzt kopieren' }).click();
  await expect(tile).toContainText('Eingebunden (cifs)', { timeout: 20_000 });
  await expect(tile).toContainText('1 neue Kopie', { timeout: 20_000 });
  await expect(tile).toContainText('Nächster Lauf');
  expect(home.storedDb).toHaveLength(1);
  expect(home.storedDb[0]?.fileName).toMatch(/^homelab-zentrale-\d{8}-\d{4}\.sqlite$/);
  expect(home.rpcs.map((r) => r.action)).toContain('backup.target.sync');
  await shots(page, 'settings', tile);
});

test('share dropped: nothing is written, WARN and a warning', async () => {
  home.setBackupTarget('not_mounted');
  const before = home.storedDb.length;
  await page.goto('/settings#backup');
  const tile = tileByTitle(page, 'NAS als Backup-Ziel');
  await tile.getByRole('button', { name: 'Jetzt kopieren' }).click();
  await expect(tile).toContainText('Freigabe nicht eingebunden', { timeout: 20_000 });
  await expect(tile).toContainText('WARN');
  expect(home.storedDb.length).toBe(before);
  const alerts = await pageFetch<{ alerts: { title: string; state: string }[] }>(
    page,
    'GET',
    '/api/alerts?state=active',
  );
  expect(alerts.data.alerts.map((a) => a.title)).toContain(
    `Backup-Ziel auf ${HOME} ist nicht eingebunden`,
  );
  await shots(page, 'not-mounted', tile);

  home.setBackupTarget('mounted');
  await tile.getByRole('button', { name: 'Jetzt kopieren' }).click();
  await expect(tile).not.toContainText('Freigabe nicht eingebunden', { timeout: 20_000 });
});

test('no serious accessibility findings', () => {
  expect(findings).toEqual([]);
});
