import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  answerStepUpIfAsked,
  enrollServer,
  ORIGIN,
  pageFetch,
  signIn,
  stepUpCall,
  type Totp,
} from './helpers/auth.js';
import {
  FAKE_FRITZ_PASSWORD,
  FAKE_FRITZ_USER,
  FAKE_KUMA_KEY,
  FAKE_PIHOLE_PASSWORD,
  FAKE_PVE_SECRET,
  FAKE_PVE_TOKEN_ID,
  FakeFritz,
  FakeKuma,
  FakeNtfy,
  FakePihole,
  FakeProxmox,
} from './helpers/fake-integrations.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M14 acceptance (docs/ROADMAP.md) against the real core and local stand-ins for
 * Proxmox, Pi-hole, FRITZ!Box (TR-064 with digest auth), Uptime Kuma and ntfy
 * (e2e/helpers/fake-integrations.ts): VMs appear and start, stopping asks for
 * confirmation, DNS blocking pauses and resumes, the FRITZ!Box shows the internet
 * and the devices, a Kuma monitor becomes a check, a server is woken through
 * another server's agent, and a test message reaches ntfy.
 */

const SHOTS = 'docs/screenshots/m14';
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const SUFFIX = Date.now().toString(36);
const SENDER = `pi-m14-${SUFFIX}`;
const SLEEPER = `nas-m14-${SUFFIX}`;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let context: BrowserContext;
let page: Page;
let totp: Totp;
let agent: SimAgent;
let sleeperId = '';
let senderId = '';
const pve = new FakeProxmox();
const pihole = new FakePihole();
const fritz = new FakeFritz();
const ntfy = new FakeNtfy();
let kuma: FakeKuma;

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function themes(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`${name}-${scheme}`);
  }
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`${name}-wall`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  await Promise.all([pve.start(), pihole.start(), fritz.start(), ntfy.start()]);
  kuma = new FakeKuma(`${ORIGIN}/api/health`);
  await kuma.start();
  context = await browser.newContext({
    baseURL: ORIGIN,
    colorScheme: 'dark',
    timezoneId: 'Europe/Vienna',
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  totp = await signIn(page);
  const a = await enrollServer(page, totp, SENDER, 'Zuhause');
  expect(a.status).toBe(200);
  const b = await enrollServer(page, totp, SLEEPER, 'Zuhause');
  expect(b.status).toBe(200);
  agent = new SimAgent({ url: AGENT_URL, name: SENDER, token: a.data.token });
  await agent.connect();
  // The sleeper exists once its agent was connected once; then it goes off.
  const sleeper = new SimAgent({ url: AGENT_URL, name: SLEEPER, token: b.data.token });
  await sleeper.connect();
  sleeper.disconnect();
  const list = await pageFetch<{ servers: { id: string; name: string }[] }>(
    page,
    'GET',
    '/api/servers',
  );
  senderId = list.data.servers.find((s) => s.name === SENDER)?.id ?? '';
  sleeperId = list.data.servers.find((s) => s.name === SLEEPER)?.id ?? '';
  expect(senderId).not.toBe('');
  expect(sleeperId).not.toBe('');
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
  await Promise.all([pve.stop(), pihole.stop(), fritz.stop(), ntfy.stop(), kuma?.stop()]);
});

test('the four modules are off by default and switch on with step-up', async () => {
  const before = await pageFetch<Record<string, boolean>>(page, 'GET', '/api/settings/modules');
  expect(before.data).toMatchObject({
    proxmox: false,
    dnsfilter: false,
    fritzbox: false,
    uptimekuma: false,
  });
  const off = await pageFetch<{ error: string }>(page, 'GET', '/api/proxmox/guests');
  expect(off.status).toBe(404);
  expect(off.data.error).toBe('module_disabled');
  const on = await stepUpCall(page, totp, 'PUT', '/api/settings/modules', {
    proxmox: true,
    dnsfilter: true,
    fritzbox: true,
    uptimekuma: true,
  });
  expect(on.status).toBe(200);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link', { name: /VMs/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Netzwerk/ })).toBeVisible();
});

test('connect Proxmox in the settings, the secret stays hidden', async () => {
  await page.goto('/settings#anbindung-proxmox');
  const tile = page.locator('#anbindung-proxmox');
  await tile.getByLabel('Adresse').fill(pve.url);
  await tile.getByLabel(/API-Token-ID/).fill(FAKE_PVE_TOKEN_ID);
  await tile.getByLabel(/Secret/).fill(FAKE_PVE_SECRET);
  await tile.getByRole('button', { name: 'Speichern' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(tile.getByText(/^OK/).first()).toBeVisible({ timeout: 15_000 });
  const s = await pageFetch<Record<string, unknown>>(page, 'GET', '/api/proxmox/settings');
  expect(s.data).toMatchObject({ secretSet: true, status: 'ok' });
  expect(JSON.stringify(s.data)).not.toContain(FAKE_PVE_SECRET);
  await expect(page.locator('body')).not.toContainText(FAKE_PVE_SECRET);

  for (const [id, body] of [
    ['dnsfilter', { url: pihole.url, variant: 'pihole', secret: FAKE_PIHOLE_PASSWORD }],
    ['fritzbox', { url: fritz.url, username: FAKE_FRITZ_USER, secret: FAKE_FRITZ_PASSWORD }],
    ['uptimekuma', { url: kuma.url, secret: FAKE_KUMA_KEY }],
  ] as const) {
    const r = await stepUpCall<{ status: string; error: string | null }>(
      page,
      totp,
      'PUT',
      `/api/${id}/settings`,
      body,
    );
    expect(r.status, id).toBe(200);
    expect(r.data.status, `${id}: ${r.data.error ?? ''}`).toBe('ok');
  }
  await page.reload();
  await themes('settings-anbindungen');
});

test('VMs: list, start a stopped VM, stop asks for confirmation', async () => {
  await page.goto('/vms');
  const rows = page.getByTestId('guest');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'ubuntu-vorlage' })).toContainText('Vorlage');
  await themes('vms');

  const win = rows.filter({ hasText: 'win11' });
  await win.getByRole('button', { name: 'win11 starten' }).click();
  await expect.poll(() => pve.actions).toContain('qemu/102/start');

  const ha = rows.filter({ hasText: 'homeassistant' });
  await ha.getByRole('button', { name: 'homeassistant stoppen' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'homeassistant' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Stoppen/ }).click();
  await answerStepUpIfAsked(page, totp);
  await expect.poll(() => pve.actions).toContain('qemu/101/stop');

  // A guest that is not in the list cannot be touched, whatever the path says.
  const unknown = await stepUpCall<{ error: string }>(
    page,
    totp,
    'POST',
    '/api/proxmox/guests/pve/qemu/4242/stop',
    { confirm: true },
  );
  expect(unknown.status).toBe(404);
  expect(pve.actions).not.toContain('qemu/4242/stop');
});

test('Netzwerk: internet, devices, DNS blocking pauses and resumes', async () => {
  await page.goto('/network');
  await expect(page.getByText('Internet verbunden').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'Geräte' })).toContainText('heimserver');
  await expect(page.getByRole('list', { name: 'Geräte' })).toContainText('Handy & Tablet');
  await expect(page.getByText('48.213')).toBeVisible();
  await themes('network');

  await page.getByRole('button', { name: '5 Min pausieren', exact: true }).click();
  await expect.poll(() => pihole.blocking).toBe(false);
  expect(pihole.timer).toBe(300);
  await expect(page.getByText(/pausiert bis/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Wieder blocken' }).click();
  await expect.poll(() => pihole.blocking).toBe(true);
  // Every TR-064 call was digest-authenticated (the fake refuses anything else).
  expect(fritz.requests.some((r) => r.auth?.startsWith('Digest '))).toBe(true);
});

test('Uptime Kuma: a monitor becomes a check', async () => {
  await page.goto('/websites');
  const kumaTile = page.locator('section, div').filter({ hasText: 'Uptime Kuma' }).last();
  await expect(page.getByText('Meine Website').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('checkbox', { name: /Meine Website/ }).check();
  await page.getByRole('button', { name: /übernehmen$/i }).click();
  await expect(kumaTile.getByText(/übernommen/).first()).toBeVisible();
  const checks = await pageFetch<{ checks: { def: { name: string; kind: string } }[] }>(
    page,
    'GET',
    '/api/checks',
  );
  expect(
    checks.data.checks.some((c) => c.def.name === 'Meine Website' && c.def.kind === 'http'),
  ).toBe(true);
  await themes('websites-kuma');
});

test('Wake-on-LAN: a server that is off is woken through another server', async () => {
  const put = await pageFetch(page, 'PUT', `/api/servers/${sleeperId}/wol`, {
    mac: 'aa-bb-cc-dd-ee-f0',
    broadcast: '192.168.178.255',
    port: 9,
    via: senderId,
  });
  expect(put.status).toBe(200);
  await page.goto(`/servers/${sleeperId}`);
  const wake = page.getByRole('button', { name: 'Aufwecken' });
  await expect(wake).toBeVisible();
  await themes('server-wol');
  await wake.click();
  await expect
    .poll(() => agent.rpcs.find((r) => r.action === 'wol.send')?.params)
    .toEqual({ mac: 'AA:BB:CC:DD:EE:F0', broadcast: '192.168.178.255', port: 9 });
});

test('alert channel ntfy: test message arrives, addresses masked', async () => {
  await page.goto('/settings');
  const ch = page.getByTestId('channel-ntfy');
  await ch.scrollIntoViewIfNeeded();
  await ch.getByLabel('Server').fill(ntfy.url);
  await ch.getByLabel('Thema').fill(`zentrale-${SUFFIX}`);
  await ch.getByRole('button', { name: 'Speichern' }).click();
  await answerStepUpIfAsked(page, totp);
  await expect(ch.getByRole('button', { name: 'Testnachricht' })).toBeEnabled();
  await ch.getByRole('button', { name: 'Testnachricht' }).click();
  await expect.poll(() => ntfy.messages.length).toBeGreaterThan(0);
  expect(ntfy.messages[0]?.topic).toBe(`zentrale-${SUFFIX}`);
  await expect(ch.getByText(/Testnachricht an .* gesendet/)).toBeVisible();
  await themes('settings-kanaele');
});

test('switching a module off hides it again and its API answers 404', async () => {
  const r = await pageFetch(page, 'PUT', '/api/settings/modules', { proxmox: false });
  expect(r.status).toBe(200);
  const off = await pageFetch<{ error: string }>(page, 'GET', '/api/proxmox/guests');
  expect(off.status).toBe(404);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: /VMs/ })).toHaveCount(0);
  await themes('overview-heimnetz');
});
