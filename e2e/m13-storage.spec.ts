import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { enrollServer, ORIGIN, setModules, signIn, type Totp } from './helpers/auth.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M13 NAS und Speicher (docs/ROADMAP.md) against the real core and a simulated UGREEN NAS:
 * - The server detail shows "Speicher" with RAID, volumes and disks (SMART, temperature,
 *   sleeping disk), the overview the tile "Speicher".
 * - A disk drops out of the RAID: the detail shows "Beschädigt", a crit alert
 *   "RAID md1 auf … ist beschädigt" opens. Back to 2/2: the alert is resolved.
 * - Module off: the section and the tile disappear.
 * Screenshots in docs/screenshots/m13/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m13';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const NAS = `nas-m13-${SUFFIX}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];
const TB = 1024 ** 4;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let nas: SimAgent;
let nasId = '';
const findings: string[] = [];

const readAt = new Date().toISOString();
function storage(degraded: boolean): Record<string, unknown> {
  return {
    platform: { kind: 'ugreen', vendor: 'UGREEN', model: 'DXP2800' },
    smart: 'on',
    arrays: [
      {
        name: 'md1',
        level: 'raid1',
        state: degraded ? 'degraded' : 'clean',
        devicesTotal: 2,
        devicesActive: degraded ? 1 : 2,
        members: [
          { device: 'sda3', disk: 'sda', failed: false, spare: false },
          { device: 'sdb3', disk: 'sdb', failed: degraded, spare: false },
        ],
        sizeBytes: 3.6 * TB,
      },
    ],
    volumes: [
      {
        mount: '/volume1',
        fs: 'btrfs',
        usedBytes: 1.3 * TB,
        totalBytes: 3.6 * TB,
        arrays: ['md1'],
        disks: ['sda', 'sdb'],
      },
    ],
    disks: [
      {
        name: 'nvme0n1',
        kind: 'nvme',
        model: 'Samsung SSD 990 PRO 1TB',
        sizeBytes: 1_000_204_886_016,
        tempC: 41.9,
        standby: false,
        smart: { health: 'passed', powerOnHours: 2100, mediaErrors: 0, wearPct: 3, readAt },
      },
      {
        name: 'sda',
        kind: 'hdd',
        model: 'WDC WD40EFPX',
        sizeBytes: 4_000_787_030_016,
        tempC: 37,
        standby: false,
        smart: { health: 'passed', powerOnHours: 8760, reallocated: 0, pending: 0, readAt },
      },
      {
        name: 'sdb',
        kind: 'hdd',
        model: 'WDC WD40EFPX',
        sizeBytes: 4_000_787_030_016,
        tempC: null,
        standby: true,
        smart: { health: 'passed', powerOnHours: 8754, reallocated: 0, pending: 0, readAt },
      },
    ],
  };
}

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
  await setModules(page, totp, { storage: true });
  const enroll = await enrollServer(page, totp, NAS, 'Abstellraum');
  expect(enroll.status).toBe(200);
  nas = new SimAgent({
    url: AGENT_URL,
    name: NAS,
    token: enroll.data.token,
    containers: [],
    storage: storage(false),
  });
  await nas.connect();
  nasId = nas.serverId ?? '';
});

test.afterAll(async () => {
  nas?.disconnect();
  await context?.close();
});

test('server detail shows RAID, volumes and disks; overview has the tile', async () => {
  await page.goto(`/servers/${nasId}`);
  const tile = tileByTitle(page, 'Speicher');
  // The section loads after the server detail (own query).
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile).toContainText('UGREEN-NAS');
  await expect(tile).toContainText('RAID 1 · 2/2 Platten');
  await expect(tile).toContainText('/volume1 (btrfs)');
  await expect(tile).toContainText('sda · WDC WD40EFPX');
  await expect(tile).toContainText('8.760 Stunden');
  await expect(tile).toContainText('37 °C');
  await expect(tile).toContainText('schläft');
  await shots(page, 'detail', tile);

  await page.goto('/');
  const over = tileByTitle(page, 'Speicher');
  await expect(over).toContainText(NAS);
  await shots(page, 'overview', over);
});

test('a failed disk degrades the RAID: crit alert, resolved after the rebuild', async () => {
  nas.setStorage(storage(true));
  await page.goto(`/servers/${nasId}`);
  const tile = tileByTitle(page, 'Speicher');
  await expect(tile).toContainText('Beschädigt', { timeout: 40_000 });
  await expect(tile).toContainText(`RAID md1 auf ${NAS} ist beschädigt`);
  await shots(page, 'degraded', tile);

  await page.goto('/alerts');
  await expect(page.getByText(`RAID md1 auf ${NAS} ist beschädigt`).first()).toBeVisible();

  nas.setStorage(storage(false));
  await page.goto(`/servers/${nasId}`);
  await expect(tileByTitle(page, 'Speicher')).not.toContainText('Beschädigt', { timeout: 40_000 });
});

test('module off hides the section and the overview tile', async () => {
  await setModules(page, totp, { storage: false });
  await page.goto(`/servers/${nasId}`);
  await expect(tileByTitle(page, 'Auslastung')).toBeVisible({ timeout: 15_000 });
  await expect(tileByTitle(page, 'Speicher')).toHaveCount(0);
  await page.goto('/');
  await expect(tileByTitle(page, 'Speicher')).toHaveCount(0);
  await setModules(page, totp, { storage: true });
  expect(findings).toEqual([]);
});
