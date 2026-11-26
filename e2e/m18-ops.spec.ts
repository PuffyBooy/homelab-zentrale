import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { enrollServer, ORIGIN, setModules, signIn, type Totp } from './helpers/auth.js';
import { hexId, imageId, SimAgent, type SimContainer, type SimOps } from './helpers/sim-agent.js';

/**
 * M18 add-on modules (docs/ROADMAP.md) against the real core and a simulated agent that
 * answers logs.search, image.scan and fail2ban.*:
 * - Module switches for Log-Suche, Sicherheit (vulnscan, fail2ban), Discord-Bot and
 *   Sprachsteuerung (the last two with step-up).
 * - Log-Suche finds a line in a container log and marks the match.
 * - Sicherheit: a manual scan lists the containers with CRIT/HIGH, Fail2ban shows the jail
 *   with its banned IPs, unban asks first and the IP disappears.
 * - Settings show the sections Discord-Bot and Sprachsteuerung.
 * Screenshots in docs/screenshots/m18/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m18';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const HOST = `vps-m18-${SUFFIX}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];
const BANNED = '203.0.113.7';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
const findings: string[] = [];

function container(name: string, image: string): SimContainer {
  return {
    dockerId: hexId(),
    name,
    image,
    imageId: imageId(),
    state: 'running',
    health: 'none',
    statusText: 'Up 3 days',
    startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ports: [],
  };
}

const ops: SimOps = {
  logs: {
    nginx: [
      'GET /api/health 200 0.004',
      'ERROR upstream timed out (110: Connection timed out) while reading response header',
      'GET / 200 0.012',
    ],
    redis: ['Ready to accept connections tcp', 'DB saved on disk'],
    'my-app': ['listening on :3000'],
  },
  scans: {
    nginx: {
      vulns: [
        {
          id: 'CVE-2026-1234',
          pkg: 'openssl',
          installed: '3.0.11',
          fixed: '3.0.15',
          severity: 'CRITICAL',
          title: 'Heap overflow in X.509 parsing',
        },
        {
          id: 'CVE-2026-2211',
          pkg: 'libxml2',
          installed: '2.9.14',
          fixed: '2.9.14+dfsg-1.3',
          severity: 'HIGH',
          title: 'Use after free in xmlXIncludeAddNode',
        },
      ],
    },
    redis: {
      vulns: [
        {
          id: 'CVE-2026-3301',
          pkg: 'libc6',
          installed: '2.36-9',
          fixed: null,
          severity: 'HIGH',
          title: 'Stack read overflow in getaddrinfo',
        },
      ],
    },
  },
  jails: [
    { name: 'sshd', bannedIps: [BANNED, '198.51.100.23', '2001:db8::17'] },
    { name: 'nginx-botsearch', bannedIps: ['192.0.2.44'] },
  ],
};

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
  // signIn and the step-ups may each wait for a fresh 30-s TOTP window.
  test.setTimeout(180_000);
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  const enroll = await enrollServer(page, totp, HOST, 'Falkenstein');
  expect(enroll.status).toBe(200);
  agent = new SimAgent({
    url: AGENT_URL,
    name: HOST,
    token: enroll.data.token,
    containers: [
      container('nginx', 'nginx:1.27'),
      container('redis', 'redis:7.4'),
      container('my-app', 'my-app:latest'),
    ],
    ops,
  });
  await agent.connect();
});

test.afterAll(async () => {
  if (page) {
    await setModules(page, totp, {
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
    }).catch(() => undefined);
  }
  agent?.disconnect();
  await context?.close();
});

test('modules switch on: Log-Suche and Sicherheit appear in the navigation', async () => {
  await setModules(page, totp, {
    logsearch: true,
    vulnscan: true,
    fail2ban: true,
    discordbot: true,
    voice: true,
  });
  await page.goto('/settings#module');
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: /Log-Suche/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Sicherheit/ })).toBeVisible();
});

test('Log-Suche finds the line and marks the match', async () => {
  await page.goto('/logs');
  await page.getByLabel('Suchtext').fill('upstream timed out');
  await page.getByRole('button', { name: 'Suchen', exact: true }).click();
  const hit = page.getByTestId('log-hit').filter({ hasText: 'upstream timed out' });
  await expect(hit).toHaveCount(1, { timeout: 30_000 });
  await expect(hit).toContainText(HOST);
  await expect(hit).toContainText('nginx');
  await expect(hit).toContainText('stderr');
  await expect(hit.locator('mark')).toHaveText('upstream timed out');
  const server = page.getByTestId('logsearch-server').filter({ hasText: HOST });
  await expect(server).toContainText('3 Container durchsucht');
  const call = agent.rpcs.find((r) => r.action === 'logs.search');
  expect(call?.params.query).toBe('upstream timed out');
  await shots(page, 'logsearch');
});

test('Sicherheit: manual scan lists CRIT and HIGH per container', async () => {
  await page.goto('/security');
  const tile = tileByTitle(page, 'Schwachstellen');
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.getByRole('button', { name: 'Jetzt prüfen' }).click();
  const rows = tile.getByTestId('vuln-row');
  const nginx = rows.filter({ hasText: 'nginx' });
  await expect(nginx).toContainText('1 CRIT · 1 HIGH', { timeout: 40_000 });
  await expect(rows.filter({ hasText: 'redis' })).toContainText('0 CRIT · 1 HIGH');
  await expect(rows.filter({ hasText: 'my-app' })).toContainText('nicht prüfbar (lokal gebaut)');
  await expect(tile.locator('.hz-tile-head')).toContainText('1 mit kritischen Lücken');
  await nginx.getByRole('button', { name: 'Lücken in nginx zeigen' }).click();
  await expect(nginx).toContainText('CVE-2026-1234');
  await expect(nginx).toContainText('3.0.15');
  expect(agent.rpcs.filter((r) => r.action === 'image.scan')).toHaveLength(3);
  await shots(page, 'vulnscan', tile);
});

test('Sicherheit: Fail2ban shows jails and unbans after confirmation', async () => {
  await page.goto('/security');
  const tile = tileByTitle(page, `Fail2ban · ${HOST}`);
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile.locator('.hz-tile-count')).toHaveText('4');
  const sshd = tile.getByTestId('fail2ban-jail').filter({ hasText: 'sshd' });
  await expect(sshd).toContainText('3 gesperrt');
  await expect(sshd.getByTestId('banned-ip')).toHaveCount(3);
  await expect(
    tile.getByTestId('fail2ban-jail').filter({ hasText: 'nginx-botsearch' }),
  ).toBeVisible();
  await shots(page, 'fail2ban', tile);

  // Cancel first: nothing happens.
  await sshd.getByRole('button', { name: `${BANNED} in sshd entsperren` }).click();
  let dialog = page.getByRole('dialog', { name: `${BANNED} entsperren?` });
  await expect(dialog).toBeVisible();
  await shots(page, 'fail2ban-unban');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  expect(agent.rpcs.some((r) => r.action === 'fail2ban.unban')).toBe(false);

  await sshd.getByRole('button', { name: `${BANNED} in sshd entsperren` }).click();
  dialog = page.getByRole('dialog', { name: `${BANNED} entsperren?` });
  await dialog.getByRole('button', { name: 'Entsperren' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sshd.getByTestId('banned-ip')).toHaveCount(2);
  await expect(sshd).not.toContainText(BANNED);
  await expect(tile.locator('.hz-tile-count')).toHaveText('3');
  const unban = agent.rpcs.find((r) => r.action === 'fail2ban.unban');
  expect(unban?.params).toEqual({ jail: 'sshd', ip: BANNED });
});

test('settings show Discord-Bot and Sprachsteuerung', async () => {
  await page.goto('/settings#discord-bot');
  const discord = tileByTitle(page, 'Discord-Bot');
  await expect(discord).toBeVisible({ timeout: 15_000 });
  await shots(page, 'discordbot', discord);

  await page.goto('/settings#sprachsteuerung');
  const voice = tileByTitle(page, 'Sprachsteuerung (Echo Show / Alexa)');
  await expect(voice).toBeVisible({ timeout: 15_000 });
  await expect(voice).toContainText('Home Assistant ist nicht verbunden.');
  await shots(page, 'voice', voice);
  expect(findings).toEqual([]);
});
