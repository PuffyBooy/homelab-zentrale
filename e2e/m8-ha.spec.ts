import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  answerStepUp,
  answerStepUpIfAsked,
  enrollServer,
  ORIGIN,
  signIn,
  type Totp,
} from './helpers/auth.js';
import { FAKE_HA_TOKEN, FakeHa } from './helpers/fake-ha.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M8 acceptance (docs/ROADMAP.md) against the real core and a fake Home Assistant
 * (e2e/helpers/fake-ha.ts, HA WebSocket API on 127.0.0.1): connect in the settings,
 * pick rooms and entities, switch a light in the UI (HA gets call_service and reports
 * state_changed back), a sensor changes live, the door opener asks for confirmation
 * and step-up, and an HA outage shows "Home Assistant nicht erreichbar". A fresh install
 * has the Home Assistant module off: it is switched on in Einstellungen → Module first.
 */

const SHOTS = 'docs/screenshots/m8';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const AGENT_NAME = `heimserver-m8-${Date.now().toString(36)}`;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
const ha = new FakeHa();

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

/** Page shot, or only `target` (settings tiles further down the page). */
async function shot(name: string, fullPage = true, target?: Locator): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  if (target) await target.screenshot({ path: `${SHOTS}/${name}.png` });
  else await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function themes(name: string, fullPage = true, target?: Locator): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`e2e-${name}-${scheme}`, fullPage, target);
  }
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`e2e-${name}-wall`, fullPage, target);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

async function phone(name: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await shot(`e2e-${name}-phone-dark`);
  await page.setViewportSize({ width: 1280, height: 900 });
}

const toggle = (entity: string) =>
  page.locator(`[data-testid="ha-toggle"][data-entity="${entity}"]`).getByRole('switch');
const metric = (entity: string) =>
  page.locator(`[data-testid="ha-metric"][data-entity="${entity}"]`);

test.beforeAll(async ({ browser }) => {
  // signIn and the step-up for the enrollment may each wait for a fresh TOTP window.
  test.setTimeout(120_000);
  await ha.start();
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  // The overview needs a server; the HA tile sits below the server list.
  const enroll = await enrollServer(page, totp, AGENT_NAME, 'Zuhause');
  expect(enroll.status).toBe(200);
  agent = new SimAgent({ url: AGENT_URL, name: AGENT_NAME, token: enroll.data.token });
  await agent.connect();
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
  await ha.stop();
});

test('the Home Assistant module is switched on in the settings', async () => {
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const modules = await apiCall<{ homeassistant: boolean }>('GET', '/api/settings/modules');
  test.skip(modules.data.homeassistant, 'module already on (reused core)');
  await page.goto('/');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: /Wohnung/ })).toHaveCount(0);
  await page.goto('/home');
  await expect(page.getByTestId('module-off')).toContainText('Modul ausgeschaltet.');
  await page.getByRole('link', { name: 'Einstellungen → Module' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings#module`);
  const sw = page.getByTestId('modules').getByRole('switch', { name: 'Home Assistant' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  // Switching HA on needs step-up (still active from the enrollment, then not asked).
  await answerStepUpIfAsked(page, totp);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // The nav follows without a reload.
  await expect(nav.getByRole('link', { name: /Wohnung/ })).toBeVisible();
});

test('Wohnung without Home Assistant points to the settings', async () => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav).toBeVisible();
  await expect(page.locator('.app-ha-overview')).toHaveCount(0);
  // Key caps follow the visible items (GitHub may be off).
  const key = await nav
    .getByRole('link', { name: /Wohnung/ })
    .locator('.hz-nav-key')
    .textContent();
  await page.keyboard.press(key?.trim() ?? '7');
  await expect(page).toHaveURL(`${ORIGIN}/home`);
  await expect(page.locator('.hz-page-title')).toHaveText('Home Assistant nicht verbunden.');
  await page.getByRole('link', { name: 'Home Assistant in den Einstellungen verbinden' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings#ha`);
});

test('connect Home Assistant in the settings (step-up), token stays hidden', async () => {
  const tile = page.locator('#ha');
  await expect(tile.getByText('kein Token', { exact: true })).toBeVisible();
  await tile.getByLabel('Adresse').fill(ha.url);
  await tile.getByLabel('Token', { exact: true }).fill(FAKE_HA_TOKEN);
  await tile.getByLabel('Strompreis (€/kWh)').fill('0,25');
  await tile.getByRole('button', { name: 'Speichern' }).click();
  // Step-up may still be active from the enrollment and the module switch.
  await answerStepUpIfAsked(page, totp);
  await expect(tile.getByText('Token gesetzt', { exact: true })).toBeVisible();
  await expect(tile.getByLabel('Neuer Token')).toHaveValue('');
  await expect(tile.locator('.hz-tile-head .hz-status-label')).toHaveText('verbunden', {
    timeout: 15_000,
  });

  // Pickers fill once HA is connected.
  await expect(tile.getByLabel('Energie-Sensor (kWh)')).toBeEnabled();
  await tile.getByLabel('Energie-Sensor (kWh)').selectOption('sensor.strom_zaehler');
  await tile.getByLabel('Leistungs-Sensor (W)').selectOption('sensor.strom_leistung');
  await tile.getByRole('button', { name: 'Speichern' }).click();
  await expect(tile.getByText('Gespeichert.')).toBeVisible();
  const s = await apiCall<{ powerEntityId: string; pricePerKwh: number }>(
    'GET',
    '/api/ha/settings',
  );
  expect(s.data).toMatchObject({ powerEntityId: 'sensor.strom_leistung', pricePerKwh: 0.25 });
});

test('pick rooms and entities, kinds limited to the allowed ones', async () => {
  const tile = page.locator('#ha-geraete');
  for (const name of ['Wohnzimmer', 'Küche', 'Vorraum']) {
    await tile.getByLabel('Neuer Raum').fill(name);
    await tile.getByRole('button', { name: 'Raum anlegen' }).click();
  }
  await expect(tile.getByTestId('ha-room')).toHaveCount(3);

  await tile.getByRole('button', { name: 'Gerät hinzufügen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gerät hinzufügen' });
  // Automations have no allowed kind and are not offered.
  await dialog.getByLabel('Suchen').fill('automation');
  await expect(dialog.getByText('Keine Entität passt zu „automation“.')).toBeVisible();
  for (const id of [
    'light.wohnzimmer',
    'light.stehlampe',
    'sensor.wohnzimmer_temperatur',
    'sensor.wohnzimmer_luftfeuchte',
    'sensor.wohnzimmer_co2',
    'switch.kaffeemaschine',
    'lock.haustuer',
  ]) {
    await dialog.getByLabel('Suchen').fill(id);
    await dialog.getByRole('button', { name: `${id} hinzufügen` }).click();
    await expect(dialog.locator(`[data-entity="${id}"]`).getByText('gewählt')).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Fertig' }).click();

  const row = (id: string) => tile.locator(`[data-testid="ha-entity"][data-entity="${id}"]`);
  await expect(tile.getByTestId('ha-entity')).toHaveCount(7);
  // Room from the HA area, kind from the domain; a lock can only be a button.
  await expect(row('light.wohnzimmer').getByLabel('Raum')).toHaveValue('wohnzimmer');
  await expect(row('lock.haustuer').getByLabel('Art').locator('option')).toHaveText(['Taster']);
  await expect(row('switch.kaffeemaschine').getByLabel('Art').locator('option')).toHaveCount(2);
  await row('light.wohnzimmer').getByRole('switch', { name: 'in Übersicht' }).click();
  await row('sensor.wohnzimmer_temperatur').getByRole('switch', { name: 'in Übersicht' }).click();
  await row('lock.haustuer').getByLabel('Bezeichnung').fill('Haustür unten');
  await tile.getByRole('button', { name: 'Auswahl speichern' }).click();
  await expect(tile.getByText('Auswahl gespeichert.')).toBeVisible();
  await themes('settings-ha', false, page.locator('#ha'));
  await themes('settings-ha-entities', false, tile);
});

test('toggle a light: HA gets call_service and the UI follows its state', async () => {
  await page.goto('/home');
  const light = toggle('light.wohnzimmer');
  await expect(light).toHaveAttribute('aria-checked', 'false');
  await expect(metric('sensor.wohnzimmer_temperatur')).toContainText('21,4');
  await expect(metric('sensor.wohnzimmer_temperatur')).toContainText('°C');
  await expect(page.getByTestId('ha-energy')).toContainText('412');

  await light.click();
  await expect(light).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => ha.callsFor('light', 'turn_on').flatMap((c) => c.entityIds))
    .toContain('light.wohnzimmer');
  await expect(page.locator('[data-entity="light.wohnzimmer"]')).not.toContainText('schaltet');
  expect(ha.states.get('light.wohnzimmer')?.state).toBe('on');

  // A change at the device (wall switch) shows up live.
  ha.setState('light.wohnzimmer', 'off');
  await expect(light).toHaveAttribute('aria-checked', 'false');
});

test('sensors update live', async () => {
  ha.setState('sensor.wohnzimmer_temperatur', '22.73');
  await expect(metric('sensor.wohnzimmer_temperatur')).toContainText('22,7');
  ha.setState('sensor.strom_leistung', '1240');
  await expect(page.getByTestId('ha-energy')).toContainText('1240');
  await expect(page.locator('.hz-page-title')).toContainText('von 3 Schaltern an');
  await themes('home');
  await phone('home');
});

test('the door opener is a button with confirm and step-up, never a toggle', async () => {
  const row = page.locator('[data-testid="ha-press"][data-entity="lock.haustuer"]');
  await expect(row.getByRole('switch')).toHaveCount(0);
  await row.getByRole('button', { name: 'Haustür unten: Tür öffnen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Haustür unten: Tür öffnen?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tür öffnen' })).toHaveClass(/hz-btn-danger/);
  await shot('e2e-home-door-confirm-dark', false);
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  expect(ha.calls.filter((c) => c.domain === 'lock')).toHaveLength(0);

  // Without the confirm flag the core refuses, too.
  const raw = await apiCall('POST', '/api/ha/entities/lock.haustuer/press', {});
  expect(raw.status).toBe(400);

  await row.getByRole('button', { name: 'Haustür unten: Tür öffnen' }).click();
  await dialog.getByRole('button', { name: 'Tür öffnen' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  if (await stepUp.isVisible({ timeout: 3000 }).catch(() => false)) {
    await answerStepUp(page, totp);
  }
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => ha.calls.filter((c) => c.domain === 'lock').flatMap((c) => c.entityIds))
    .toContain('lock.haustuer');
  await expect(row).toContainText('ausgelöst');
});

test('overview tile "Wohnung" with climate, power and the overview switch', async () => {
  await page.goto('/');
  const tile = page.locator('.app-ha-overview');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('Strom jetzt');
  await expect(tile).toContainText('22,7');
  await expect(tile.getByRole('switch', { name: 'Licht Wohnzimmer' })).toBeVisible();
  await expect(tile.getByRole('switch', { name: 'Stehlampe' })).toHaveCount(0);
  await tile.getByRole('switch', { name: 'Licht Wohnzimmer' }).click();
  await expect(tile.getByRole('switch', { name: 'Licht Wohnzimmer' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect.poll(() => ha.states.get('light.wohnzimmer')?.state).toBe('on');
  await tile.scrollIntoViewIfNeeded();
  await themes('overview-ha');
});

test('command palette switches an overview light', async () => {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Wohin?' }).fill('licht wohn');
  await expect(page.getByRole('option', { name: /Licht Wohnzimmer ausschalten/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => ha.states.get('light.wohnzimmer')?.state).toBe('off');
});

test('Home Assistant down: alert and greyed items', async () => {
  await page.goto('/home');
  await expect(toggle('light.wohnzimmer')).toBeEnabled();
  await ha.stop();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Home Assistant nicht erreichbar' }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(toggle('light.wohnzimmer')).toBeDisabled();
  await expect(metric('sensor.wohnzimmer_temperatur')).toContainText('22,7');
  await themes('home-unreachable');
});
