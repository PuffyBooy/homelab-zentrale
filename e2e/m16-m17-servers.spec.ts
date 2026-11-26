import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  answerStepUp,
  answerStepUpIfAsked,
  enrollServer,
  ORIGIN,
  pageFetch,
  signIn,
  withStepUpSession,
  type Totp,
} from './helpers/auth.js';
import { hexId, imageId, SimAgent } from './helpers/sim-agent.js';

/**
 * M16 Server im Detail and M17 Auto-Update (docs/ROADMAP.md) against the real core and a
 * simulated agent:
 * - Verlauf switches between 1 h and 30 Tage; "Größte Ordner" opens a subfolder and goes
 *   back; the Docker-Belegung shows; Aufräumen with a single item cleans only that item.
 * - A failed unit from the inventory shows first (DOWN) and raises a warn alert; an allowed
 *   unit is restarted; the process list sorts by RAM.
 * - Herunterfahren needs the name and step-up (cancelled first, then confirmed).
 * - Auto-Update: "Jetzt prüfen" finds the newer agent image, "Jetzt aktualisieren" ends
 *   with "aktualisiert"; turning on "Neustart bei Bedarf" asks for a code; Settings →
 *   Updates lists the server and the run.
 * Screenshots in docs/screenshots/m16/ in dark, light and wall, each checked with axe.
 */

const SHOTS = 'docs/screenshots/m16';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const NAME = `srv-m16-${SUFFIX}`;
const THEMES = ['dark', 'light', 'wall'] as const;
type Theme = (typeof THEMES)[number];

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
let serverId = '';
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

function rpcs(action: string): Record<string, unknown>[] {
  return agent.rpcs.filter((r) => r.action === action).map((r) => r.params);
}

async function openDetail(): Promise<void> {
  await page.goto(`/servers/${serverId}`);
  await expect(tileByTitle(page, 'Auslastung')).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  // signIn and the step-up session may each wait for a fresh TOTP window.
  test.setTimeout(180_000);
  // Enroll in a second session, so this page has no step-up yet (shutdown must ask).
  const token = await withStepUpSession(browser, async (p, t) => {
    const res = await enrollServer(p, t, NAME, 'Zuhause');
    expect(res.status).toBe(200);
    return res.data.token;
  });
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  agent = new SimAgent({
    url: AGENT_URL,
    name: NAME,
    token,
    metricsEveryMs: 2000,
    failedServices: ['backup-sync.service'],
    containers: [
      {
        dockerId: hexId(),
        name: 'homelab-agent',
        image: 'ghcr.io/example/homelab-agent:latest',
        imageId: imageId(),
        state: 'running',
        health: 'healthy',
        statusText: 'Up 2 days',
        ports: [],
        role: 'agent',
      },
    ],
  });
  await agent.connect();
  serverId = agent.serverId ?? '';
  expect(serverId).not.toBe('');
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
});

test('section nav and Verlauf from 1 h to 30 Tage', async () => {
  await openDetail();
  const nav = page.getByRole('navigation', { name: 'Bereiche des Servers' });
  for (const s of ['Überblick', 'Verlauf', 'Speicher', 'Dienste', 'Prozesse', 'Updates']) {
    await expect(nav.getByRole('link', { name: s })).toBeVisible();
  }
  const tile = tileByTitle(page, 'Verlauf');
  const range = tile.getByRole('group', { name: 'Zeitraum' });
  for (const label of ['1 h', '7 Tage', '30 Tage', '24 h']) {
    const btn = range.getByRole('button', { name: label, exact: true });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(tile.getByRole('list', { name: `Verlauf ${label}` })).toBeVisible();
  }
  await range.getByRole('button', { name: '1 h', exact: true }).click();
  for (const row of ['CPU', 'RAM', 'Netz ein', 'Netz aus']) {
    await expect(tile.getByRole('listitem').filter({ hasText: row }).first()).toBeVisible();
  }
  // Two metrics at 2 s give the 1-h view real points with Min/Ø/Max.
  await expect(tile).toContainText(/Min .* · Ø .* · Max /, { timeout: 15_000 });
  await nav.getByRole('link', { name: 'Verlauf' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#verlauf$/);
  await shots(page, 'verlauf', tile);
});

test('größte Ordner: into a subfolder and back, Docker-Belegung', async () => {
  await openDetail();
  const du = tileByTitle(page, 'Größte Ordner');
  await du.getByRole('button', { name: 'Ab / messen' }).click();
  const list = du.getByRole('list', { name: 'Ordner in /' });
  await expect(list).toBeVisible({ timeout: 70_000 });
  expect(rpcs('system.du')[0]).toMatchObject({ path: '/' });
  const open = list.getByRole('button', { name: / öffnen$/ }).first();
  const label = (await open.getAttribute('aria-label')) ?? '';
  const sub = label.replace(/ öffnen$/, '');
  expect(sub).toMatch(/^\/[^/]+$/);
  await open.click();
  await expect(du.getByRole('list', { name: `Ordner in ${sub}` })).toBeVisible({
    timeout: 70_000,
  });
  expect(rpcs('system.du').some((p) => p.path === sub)).toBe(true);
  await shots(page, 'groesste-ordner', du);
  await du.getByRole('button', { name: 'Zurück zu /' }).click();
  // Cached for a few minutes: no second measurement of /.
  await expect(list).toBeVisible();

  const df = tileByTitle(page, 'Docker-Belegung');
  const table = df.getByRole('table', { name: 'Docker-Belegung' });
  await expect(table).toContainText('Images', { timeout: 15_000 });
  await expect(table).toContainText('Build-Cache');
  await expect(table).toContainText('Volumes');
  await shots(page, 'docker-belegung', df);
});

test('Aufräumen with a single item cleans only that item', async () => {
  await openDetail();
  await page.getByRole('main').getByRole('button', { name: 'Aufräumen' }).click();
  const dialog = page.getByRole('dialog', { name: `${NAME} aufräumen` });
  const switches = dialog.getByRole('switch');
  await expect(switches.first()).toBeVisible({ timeout: 15_000 });
  const n = await switches.count();
  expect(n).toBeGreaterThan(1);
  // Everything is preselected.
  for (let i = 0; i < n; i++) await expect(switches.nth(i)).toHaveAttribute('aria-checked', 'true');
  const confirm = dialog.getByRole('button', { name: 'Aufräumen' });
  for (let i = 0; i < n; i++) await switches.nth(i).click();
  await expect(confirm).toBeDisabled();
  // Keep only the build cache (or the last item, if the preview has none).
  const build = dialog.getByRole('switch', { name: 'Docker-Build-Cache' });
  const keep = (await build.count()) ? build : switches.last();
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  await expect(confirm).toBeEnabled();
  await shots(page, 'aufraeumen');
  await confirm.click();
  await expect(dialog.getByText(/frei auf/)).toBeVisible({ timeout: 30_000 });
  const params = rpcs('system.cleanup').at(-1);
  expect(params?.items).toHaveLength(1);
  if (await build.count().catch(() => 0)) expect(params?.items).toEqual(['docker-build-cache']);
  await dialog.getByRole('button', { name: 'Fertig' }).click();
});

test('Dienste: failed first with an alert, an allowed unit restarts', async () => {
  const det = await pageFetch<{ failedServices?: string[] }>(
    page,
    'GET',
    `/api/servers/${serverId}`,
  );
  const failed = det.data.failedServices ?? [];
  expect(failed.length).toBeGreaterThan(0);
  const unit = failed[0] ?? '';

  await openDetail();
  const tile = tileByTitle(page, 'Dienste');
  await expect(tile.getByText(unit).first()).toBeVisible({ timeout: 15_000 });
  await expect(tile.locator('.hz-status-crit').first()).toBeVisible();
  const rows = tile.getByRole('group', { name: 'Dienste', exact: true });
  await expect(rows.locator('.hz-row').first()).toContainText(unit);

  const restart = tile.getByRole('button', { name: / neu starten$/ }).first();
  await expect(restart).toBeVisible();
  const target = ((await restart.getAttribute('aria-label')) ?? '').replace(/ neu starten$/, '');
  // Units the agent does not allow have no buttons.
  const failedRow = rows.locator('.hz-row').filter({ hasText: unit }).first();
  if (unit !== target) await expect(failedRow.getByRole('button')).toHaveCount(0);
  await tile.getByLabel('Filter').fill(target.replace(/\.service$/, ''));
  await shots(page, 'dienste', tile);
  await tile.getByRole('button', { name: `${target} neu starten` }).click();
  await expect(tile.getByText(`${target} neu gestartet.`)).toBeVisible({ timeout: 15_000 });
  expect(rpcs('system.service').at(-1)).toEqual({ unit: target, op: 'restart' });

  // Stopp asks first; cancel sends nothing.
  const before = rpcs('system.service').length;
  const stop = tile.getByRole('button', { name: `${target} stoppen` });
  if (await stop.count()) {
    await stop.click();
    const confirm = page.getByRole('dialog', { name: `${target} stoppen` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    expect(rpcs('system.service').length).toBe(before);
  }

  await page.goto('/alerts');
  await expect(page.getByText(`Dienst ${unit} auf ${NAME} fehlgeschlagen`).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('Prozesse sort by RAM', async () => {
  await openDetail();
  const tile = tileByTitle(page, 'Prozesse');
  await expect(tile.getByRole('table', { name: 'Prozesse nach CPU' })).toBeVisible({
    timeout: 15_000,
  });
  await tile
    .getByRole('group', { name: 'Sortieren nach' })
    .getByRole('button', { name: 'RAM' })
    .click();
  const table = tile.getByRole('table', { name: 'Prozesse nach RAM' });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(table.getByRole('columnheader', { name: 'RAM' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  expect(rpcs('system.processes').some((p) => p.sort === 'mem')).toBe(true);
  // Names only: the process rows never carry arguments.
  const names = await table.locator('tbody th').allTextContents();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n).not.toMatch(/\s-{1,2}\w/);
  await shots(page, 'prozesse', tile);
});

test('Herunterfahren needs the name and step-up', async () => {
  await openDetail();
  await page.getByRole('main').getByRole('button', { name: 'Herunterfahren' }).click();
  const dialog = page.getByRole('dialog', { name: `${NAME} herunterfahren` });
  await expect(dialog).toContainText('Wake-on-LAN');
  const confirm = dialog.getByRole('button', { name: 'Herunterfahren' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Servername').fill('falscher-name');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Servername').fill(NAME);
  await expect(confirm).toBeEnabled();
  await shots(page, 'herunterfahren');
  await confirm.click();
  const stepUp = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Bestätigung mit Code nötig.');
  expect(rpcs('system.shutdown')).toHaveLength(0);

  await confirm.click();
  await answerStepUp(page, totp);
  await expect(dialog.getByText(`${NAME} fährt herunter.`)).toBeVisible({ timeout: 15_000 });
  expect(rpcs('system.shutdown').at(-1)).toEqual({ confirmName: NAME });
  await dialog.getByRole('button', { name: 'Fertig' }).click();
});

test('Auto-Update: check, update the agent, policy with step-up, settings', async () => {
  // The sim stays up after system.shutdown; reconnect anyway, a real host would be gone.
  agent.disconnect();
  await agent.connect();
  await openDetail();
  await page
    .getByRole('navigation', { name: 'Bereiche des Servers' })
    .getByRole('link', {
      name: 'Updates',
    })
    .click();
  const tile = tileByTitle(page, 'Auto-Update');
  await expect(tile.getByText('Agent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await tile.getByRole('button', { name: 'Agent: jetzt prüfen' }).click();
  await expect(tile.getByText(/Update auf /).first()).toBeVisible({ timeout: 30_000 });
  expect(rpcs('update.check').at(-1)).toMatchObject({ target: 'agent' });
  const update = tile.getByRole('button', { name: 'Agent: jetzt aktualisieren' });
  await expect(update).toHaveClass(/hz-btn-primary/);
  await expect(tile.locator('.hz-btn-primary')).toHaveCount(1);
  await shots(page, 'auto-update', tile);
  await update.click();
  await expect(tile.getByLabel('Letzter Lauf')).toContainText('aktualisiert', {
    timeout: 60_000,
  });
  expect(rpcs('update.apply').at(-1)).toMatchObject({ target: 'agent' });

  await tile.getByRole('switch', { name: 'Neustart bei Bedarf' }).click();
  await tile.getByRole('button', { name: 'Speichern' }).click();
  await answerStepUpIfAsked(page, totp, 5000);
  await expect(tile.getByText('Richtlinie gespeichert.')).toBeVisible({ timeout: 15_000 });
  await expect(tile.getByRole('switch', { name: 'Neustart bei Bedarf' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.goto('/settings#updates');
  const settings = tileByTitle(page, 'Updates');
  await expect(settings).toContainText(NAME, { timeout: 15_000 });
  const history = settings.getByRole('table', { name: 'Update-Verlauf' });
  await expect(history.getByRole('row').filter({ hasText: NAME }).first()).toContainText(
    'aktualisiert',
  );
  await shots(page, 'settings-updates', settings);
  expect(findings).toEqual([]);
});
