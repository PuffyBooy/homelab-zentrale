import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  answerStepUp,
  enrollServer,
  ORIGIN,
  setModules,
  signIn,
  type Totp,
} from './helpers/auth.js';
import { hexId, imageId, SimAgent, type SimContainer } from './helpers/sim-agent.js';

/**
 * M9 acceptance (docs/ROADMAP.md): every page in all three themes, as a screenshot in
 * docs/screenshots/m9/ and through axe (WCAG 2.1 A/AA) without serious or critical
 * violations. Runs against the real core with a simulated agent that has containers,
 * a game server and an echo terminal, so no page is only an empty state.
 */

const SHOTS = 'docs/screenshots/m9';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const NAME = `heimserver-a11y-${Date.now().toString(36)}`;
const GAME = `welt-${Date.now().toString(36).slice(-4)}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
let serverId = '';
let containerId = '';
let gameId = '';
let checkId = '';
let shareToken = '';
let wallUrl = '';
const findings: string[] = [];
/** The friend page is apps/share (own CSS), reported separately. */
const shareFindings: string[] = [];

async function apiCall<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
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

function containers(): SimContainer[] {
  const now = new Date(Date.now() - 3 * 86400_000).toISOString();
  const c = (name: string, image: string, over: Partial<SimContainer> = {}): SimContainer => ({
    dockerId: hexId(),
    name,
    image,
    imageId: imageId(),
    state: 'running',
    health: 'healthy',
    statusText: 'Up 3 days (healthy)',
    startedAt: now,
    ports: [],
    cpu: 2.4,
    memBytes: 310 * 1024 ** 2,
    ...over,
  });
  return [
    c('homeassistant', 'ghcr.io/home-assistant/home-assistant:2026.11'),
    c('nginx', 'nginx:1.27', { ports: [{ privatePort: 80, publicPort: 8080, proto: 'tcp' }] }),
    c('backup', 'restic/restic:0.17', {
      state: 'exited',
      health: 'none',
      statusText: 'Exited (1) 2 hours ago',
      exitCode: 1,
    }),
  ];
}

async function setTheme(p: Page, theme: Theme): Promise<void> {
  await p.emulateMedia({ colorScheme: theme === 'wall' ? 'dark' : theme });
  // Let the matchMedia change event run first: the app re-applies its theme on it
  // and would otherwise overwrite the manual 'wall' (the wall shots were dark copies).
  await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await p.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
  await p.waitForTimeout(100);
  await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
}

/** axe over the page; collects serious/critical violations (checked at the end). */
async function audit(p: Page, label: string, into: string[] = findings): Promise<void> {
  const res = await new AxeBuilder({ page: p })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  for (const v of res.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    const where = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' | ');
    into.push(`${label}: ${v.id} (${v.impact}) ${where}`);
  }
}

async function shotAndAudit(
  p: Page,
  name: string,
  themes: readonly Theme[] = THEMES,
  into: string[] = findings,
) {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of themes) {
    await setTheme(p, theme);
    await p.evaluate('document.fonts.ready');
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
    // The shot only counts if the theme was still applied when it was taken.
    await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
    await audit(p, `${name} [${theme}]`, into);
  }
  await p.emulateMedia({ colorScheme: 'dark' });
}

async function newPage(browser: Browser, colorScheme: 'dark' | 'light' = 'dark') {
  const ctx = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme,
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  return { ctx, p: await ctx.newPage() };
}

test.beforeAll(async ({ browser }) => {
  // Hooks default to 30 s; signIn and the step-up for the enrollment may each wait
  // ~26 s for a fresh TOTP window, then the game setup polls up to 120 s.
  test.setTimeout(240_000);
  ({ ctx: context, p: page } = await newPage(browser));
  totp = await signIn(page);
  // Enrollment needs step-up; it then also covers the share link and the modules below.
  const enroll = await enrollServer(page, totp, NAME, 'Zuhause');
  expect(enroll.status).toBe(200);
  // Every module on, so GitHub and Wohnung are real pages in the screenshots.
  await setModules(page, totp, { github: true, homeassistant: true, games: true });
  // m8 leaves a Home Assistant behind that is gone (fake HA stopped). Without a token
  // Wohnung is the plain "nicht verbunden" state, independent of the spec order.
  const ha = await apiCall<{ tokenSet?: boolean }>('GET', '/api/ha/settings');
  if (ha.data?.tokenSet) expect((await apiCall('DELETE', '/api/ha/token')).status).toBe(200);
  agent = new SimAgent({
    url: AGENT_URL,
    name: NAME,
    token: enroll.data.token,
    containers: containers(),
    games: true,
    terminal: true,
  });
  await agent.connect();
  serverId = agent.serverId ?? '';

  await expect
    .poll(async () => {
      const r = await apiCall<{ containers: { id: string; name: string; serverId: string }[] }>(
        'GET',
        '/api/containers',
      );
      containerId =
        r.data.containers.find((c) => c.serverId === serverId && c.name === 'nginx')?.id ?? '';
      return containerId;
    })
    .not.toBe('');

  const game = await apiCall<{ game: { id: string } }>('POST', '/api/games', {
    templateId: 'minecraft-java',
    serverId,
    name: GAME,
    values: {},
    externalAddress: 'mc.example.at',
  });
  expect(game.status).toBe(202);
  gameId = game.data.game.id;
  await expect
    .poll(
      async () => {
        const r = await apiCall<{ games: { id: string; status: string }[] }>('GET', '/api/games');
        return r.data.games.find((g) => g.id === gameId)?.status;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('ok');

  const check = await apiCall<{ check: { id: string } }>('POST', '/api/checks', {
    kind: 'http',
    name: 'zentrale',
    url: `${ORIGIN}/api/health`,
  });
  checkId = check.data?.check?.id ?? '';

  const share = await apiCall<{ urls: { tailnet: string } }>(
    'POST',
    `/api/games/${gameId}/shares`,
    { person: 'Lena', perms: ['power', 'console_read'], expires: '7d' },
  );
  expect(share.status).toBe(201);
  shareToken = new URL(share.data.urls.tailnet).pathname.replace(/^\/s\//, '');

  // Console allowed + wall device: both need step-up, asked once.
  await page.goto('/settings');
  const patch = page.evaluate(
    (id) =>
      fetch(`/api/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowTerminal: true }),
      }).then((r) => r.status),
    serverId,
  );
  const first = await patch;
  if (first === 403) {
    const tile = page.locator('#wandmodus');
    await tile.getByLabel('Gerätename').fill('Tablet Küche');
    await tile.getByRole('button', { name: 'Gerät hinzufügen' }).click();
    await answerStepUp(page, totp);
    const dlg = page.getByRole('dialog', { name: 'Link für Tablet Küche' });
    wallUrl = (await dlg.locator('.app-copy-code').innerText()).trim();
    await dlg.getByRole('button', { name: 'Fertig' }).click();
    expect(
      (await apiCall('PATCH', `/api/servers/${serverId}`, { allowTerminal: true })).status,
    ).toBe(200);
  } else {
    const dev = await apiCall<{ url: string }>('POST', '/api/settings/wall-devices', {
      name: 'Tablet Küche',
    });
    wallUrl = dev.data.url;
  }
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
});

const pages = (): [string, string][] => [
  ['overview', '/'],
  ['servers', '/servers'],
  ['server-detail', `/servers/${serverId}`],
  ['containers', '/containers'],
  ['logs', `/containers/${containerId}/logs`],
  ['games', '/games'],
  ['game-new', '/games/new'],
  ['game-detail', `/games/${gameId}`],
  ['github', '/github'],
  ['websites', '/websites'],
  ...(checkId ? ([['check-detail', `/websites/${checkId}`]] as [string, string][]) : []),
  ['home', '/home'],
  ['alerts', '/alerts'],
  ['console', '/console'],
  ['settings', '/settings'],
];

test('every signed-in page in all three themes', async () => {
  for (const [name, path] of pages()) {
    await page.goto(path);
    await expect(page.locator('.hz-page-title')).toHaveText(/\S/);
    await page.waitForLoadState('networkidle');
    await shotAndAudit(page, name);
  }
});

test('console with an open session', async () => {
  await page.goto('/console');
  await page.getByRole('button', { name: `Konsole ${NAME} verbinden` }).click();
  const dlg = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  if (await dlg.isVisible().catch(() => false)) await answerStepUp(page, totp);
  await expect(page.getByTestId('console-status')).toContainText(`verbunden mit ${NAME}`);
  await page.keyboard.type('uptime');
  await page.keyboard.press('Enter');
  await expect(page.locator('.app-xterm .xterm-rows')).toContainText('echo: uptime');
  await shotAndAudit(page, 'console-open');
  await page.getByRole('button', { name: 'Trennen' }).click();
});

test('dialogs and the palette', async () => {
  await page.goto('/settings#server');
  await page.getByRole('button', { name: `${NAME} bearbeiten` }).click();
  await expect(page.getByRole('dialog', { name: `${NAME} bearbeiten` })).toBeVisible();
  await expect(page.getByLabel('CPU Warnung ab (%)')).toBeVisible();
  await shotAndAudit(page, 'settings-server-dialog');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Wohin?' }).fill(`${GAME} neu`);
  await expect(page.getByRole('option', { name: new RegExp(`${GAME} neu starten`) })).toBeVisible();
  await shotAndAudit(page, 'palette');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette-confirm')).toContainText(`${GAME} neu starten?`);
  await shotAndAudit(page, 'palette-confirm');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await page.keyboard.press('Escape');
});

test('keyboard: Tab reaches the navigation with a visible focus ring', async () => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await page.keyboard.press('Tab');
  const info = await page.evaluate<{ tag: string; ring: string; outline: string }>(
    `(() => { const el = document.activeElement; const cs = getComputedStyle(el);
      return { tag: el.tagName, ring: cs.boxShadow, outline: cs.outlineStyle }; })()`,
  );
  expect(info.tag).not.toBe('BODY');
  expect(info.ring !== 'none' || info.outline !== 'none').toBe(true);
});

test('signed-out pages: login, wall, friend page', async ({ browser }) => {
  const guest = await newPage(browser);
  await guest.p.goto('/login');
  await expect(guest.p.getByLabel('Benutzername')).toBeVisible();
  await shotAndAudit(guest.p, 'login');

  const u = new URL(wallUrl);
  await guest.p.goto(`${ORIGIN}${u.pathname}${u.search}`);
  await expect(guest.p).toHaveURL(`${ORIGIN}/wall`);
  await expect(guest.p.getByTestId('wall-tile').first()).toBeVisible();
  // /wall pins data-theme="wall"; dark/light do not apply there. At night (22–7 Vienna)
  // the view is dimmed to 40 % on purpose (SPEC 12); the audit runs on the day view.
  await guest.p.evaluate('document.fonts.ready');
  await guest.p.screenshot({ path: `${SHOTS}/wall-wall.png` });
  await guest.p.evaluate("document.querySelector('.app-wall')?.classList.remove('app-wall-night')");
  await guest.p.waitForTimeout(400);
  await guest.p.screenshot({ path: `${SHOTS}/wall-day-wall.png` });
  await audit(guest.p, 'wall [wall]');

  await guest.p.goto(`${ORIGIN}/s/${shareToken}`);
  await expect(guest.p.getByRole('heading', { level: 1 })).toHaveText(GAME);
  await shotAndAudit(guest.p, 'friend', THEMES, shareFindings);
  await guest.ctx.close();
});

test('phone layout', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [
    ['overview', '/'],
    ['console', '/console'],
    ['settings', '/settings'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('.hz-page-title')).toHaveText(/\S/);
    await shotAndAudit(page, `${name}-phone`, ['dark']);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('axe: no serious or critical violations', () => {
  expect(findings, findings.join('\n')).toEqual([]);
});

test('axe: friend page (apps/share)', () => {
  expect(shareFindings, shareFindings.join('\n')).toEqual([]);
});
