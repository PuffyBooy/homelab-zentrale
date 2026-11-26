import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { E2E_SETUP_TOKEN } from '../playwright.config.js';
import { PASSWORD, USER, loopbackOrigin } from './helpers/auth.js';
import {
  FAKE_AZURE_CLIENT,
  FAKE_AZURE_GROUP,
  FAKE_AZURE_SECRET,
  FAKE_AZURE_SUBSCRIPTION,
  FAKE_AZURE_TENANT,
  FAKE_TAILSCALE_KEY,
  FakeAzure,
} from './helpers/fake-azure.js';
import { SimAgent } from './helpers/sim-agent.js';

/**
 * M22 Cloud-Server (docs/ROADMAP.md) against an own core with HZ_DEMO=1 (the Azure hosts
 * can only be redirected to 127.0.0.1 in demo mode) and the Azure fake
 * (e2e/helpers/fake-azure.ts) as an HTTP server: link the account, order a Minecraft
 * server from the gameserver form (recommended B2ms, price confirmed), the simulated agent
 * enrolls with the code from the VM's cloud-init, the game is created and the NSG has
 * exactly its port; "Schlafen legen" deallocates the VM, a start of the game starts the VM
 * first. Screenshots in docs/screenshots/m22/.
 */

const PORT = 8094;
const ORIGIN = loopbackOrigin(PORT);
const AGENT_URL = `${ORIGIN.replace(/^http/, 'ws')}/agent`;
const DATA = 'test-results/data-m22';
const SHOTS = 'docs/screenshots/m22';
const VM = 'hz-freunde';
const GB = 1024 ** 3;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let core: ChildProcess | null = null;
let fake: FakeAzure;
let context: BrowserContext;
let page: Page;
let totp: TOTP;
let lastStep = -1;
let agent: SimAgent | null = null;
let agentToken = '';

interface Machine {
  id: string;
  name: string;
  size: string;
  state: string;
  serverId: string | null;
  gameIds: string[];
}

async function freshCode(): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 250));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp.generate();
}

async function waitForHealth(): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      // Loopback only: the core this spec started itself.
      const res = await fetch(`${ORIGIN}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('cloud core did not start');
}

async function api<T>(
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

async function machine(): Promise<Machine | undefined> {
  const r = await api<{ machines: Machine[] }>('GET', '/api/cloud');
  return r.data.machines.find((m) => m.name === VM);
}

async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function themes(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate('new Promise(requestAnimationFrame)');
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await shot(`e2e-${name}-${scheme}`);
  }
  await page.evaluate("document.documentElement.dataset.theme = 'wall'");
  await shot(`e2e-${name}-wall`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate('new Promise(requestAnimationFrame)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

async function connectAgent(): Promise<void> {
  const a = new SimAgent({
    url: AGENT_URL,
    name: VM,
    token: agentToken,
    containers: [],
    games: true,
    ramUsed: 1 * GB,
    ramTotal: 8 * GB,
    tailscaleIp: '100.64.0.42',
    listeningPorts: [],
  });
  agent = a;
  await a.connect();
  // The enrollment token is exchanged for the agent token on the first hello.
  if (a.agentToken) agentToken = a.agentToken;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  fake = new FakeAzure();
  await fake.start();
  // The VM "boots": a deallocated VM loses its agent, a started one gets it back.
  fake.onPower = (name, state) => {
    if (name !== VM || agentToken === '') return;
    if (state === 'deallocated') {
      agent?.disconnect();
      agent = null;
    } else if (agent === null) {
      void connectAgent();
    }
  };
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  core = spawn('node', ['apps/core/dist/index.js'], {
    env: {
      ...process.env,
      HZ_SECRET_KEY: Buffer.alloc(32, 2).toString('base64'),
      HZ_PORT: String(PORT),
      HZ_DATA_DIR: DATA,
      HZ_SETUP_TOKEN: E2E_SETUP_TOKEN,
      HZ_DEMO: '1',
      HZ_AZURE_LOGIN_URL: fake.url,
      HZ_AZURE_MANAGEMENT_URL: fake.url,
      HZ_AZURE_PRICES_URL: fake.url,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForHealth();

  context = await browser.newContext({ baseURL: ORIGIN, colorScheme: 'dark' });
  page = await context.newPage();
  await page.goto(`/setup#token=${E2E_SETUP_TOKEN}`);
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Passwort wiederholen').fill(PASSWORD);
  await page.getByRole('button', { name: 'Weiter' }).click();
  const secret = await page.getByTestId('totp-secret').getAttribute('data-secret');
  totp = new TOTP({ secret: Secret.fromBase32(secret ?? ''), digits: 6, period: 30 });
  await page.getByLabel('Code aus der App').fill(await freshCode());
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await page.getByRole('button', { name: 'Ich habe sie gesichert' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);

  // Switching the module on needs step-up; the same step-up covers the credentials.
  expect((await api('POST', '/api/auth/step-up', { code: await freshCode() })).status).toBe(200);
  expect((await api('PUT', '/api/settings/modules', { cloud: true })).status).toBe(200);
});

test.afterAll(async () => {
  agent?.disconnect();
  await context?.close();
  core?.kill('SIGTERM');
  await fake?.stop();
});

test('link the Azure account on the Cloud page, secrets are never shown again', async () => {
  await page.goto('/cloud');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Cloud');
  await page.getByLabel('Tenant-ID').fill(FAKE_AZURE_TENANT);
  await page.getByLabel('App-ID (Client-ID)').fill(FAKE_AZURE_CLIENT);
  await page.getByLabel('Client-Secret').fill(FAKE_AZURE_SECRET);
  await page.getByLabel('Abo-ID (Subscription)').fill(FAKE_AZURE_SUBSCRIPTION);
  await page.getByLabel('Ressourcengruppe').fill(FAKE_AZURE_GROUP);
  await page.getByLabel('Tailscale-Auth-Key').fill(FAKE_TAILSCALE_KEY);
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect
    .poll(async () => (await api<{ secretSet: boolean }>('GET', '/api/cloud/azure')).data.secretSet)
    .toBe(true);
  await page.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect
    .poll(async () => (await api<{ status: string }>('GET', '/api/cloud/azure')).data.status)
    .toBe('ok');
  // The secret is never shown again.
  await page.reload();
  await expect(page.getByLabel('Client-Secret')).toHaveValue('');
  expect(await page.content()).not.toContain(FAKE_AZURE_SECRET);
  expect(await page.content()).not.toContain(FAKE_TAILSCALE_KEY);
  await themes('cloud-linked');
});

test('order a Minecraft server from the gameserver form: B2ms, price confirmed', async () => {
  await page.goto('/games/new');
  await page.locator('.hz-tpl').filter({ hasText: 'Minecraft Java' }).click();
  await page.getByLabel('Name', { exact: true }).fill('freunde');
  await page.getByLabel('Zielserver').selectOption('cloud:azure');
  await expect(page.getByLabel('Name des Servers')).toHaveValue(VM);
  // Not the biggest size: 4 GB game RAM + 1 GB system fits a B2ms.
  await expect(page.getByLabel('Größe', { exact: true })).toHaveValue('Standard_B2ms');
  const order = page.getByRole('button', { name: 'Bestellen und aufsetzen' });
  await expect(order).toBeDisabled();
  const confirm = page.getByLabel(/Ich bestelle diesen Server für ca\./);
  await expect(confirm).toBeVisible();
  await themes('cloud-order');
  await confirm.check();
  await expect(order).toBeEnabled();
  await order.click();
  await expect(page).toHaveURL(/\/cloud/);

  // cloud-init of the VM carries the one-time code; the VM "runs install.sh".
  await expect.poll(() => fake.onboardingCode(VM), { timeout: 60_000 }).not.toBeNull();
  const vm = fake.vm(VM) as {
    properties: { hardwareProfile: { vmSize: string }; osProfile: Record<string, unknown> };
  };
  expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_B2ms');
  expect(vm.properties.osProfile).not.toHaveProperty('adminPassword');
  const ex = await fetch(`${ORIGIN}/api/onboarding/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: fake.onboardingCode(VM) }),
  });
  expect(ex.status).toBe(200);
  agentToken = /HZ_AGENT_TOKEN=['"]?([A-Za-z0-9_-]+)/.exec(await ex.text())?.[1] ?? '';
  expect(agentToken).not.toBe('');
  await connectAgent();

  await expect
    .poll(async () => (await machine())?.gameIds.length ?? 0, { timeout: 90_000 })
    .toBe(1);
  await expect.poll(async () => (await machine())?.state, { timeout: 30_000 }).toBe('running');
  // Only the game port is open: no SSH, no RCON.
  await expect.poll(() => fake.nsgPorts(VM), { timeout: 30_000 }).toEqual(['tcp/25565']);
  await page.goto('/cloud');
  await expect(page.getByTestId('cloud-machine').filter({ hasText: VM })).toContainText('Läuft');
  await themes('cloud-running');
});

test('asleep the VM is deallocated, a start of the game starts the VM first', async () => {
  // The new world is generated first (no deallocate in the middle of a setup).
  const gameId = (await machine())?.gameIds[0] ?? '';
  await expect
    .poll(
      async () =>
        (await api<{ game: { status: string } }>('GET', `/api/games/${gameId}`)).data.game.status,
      { timeout: 120_000 },
    )
    .not.toBe('busy');
  await page.goto('/cloud');
  const row = page.getByTestId('cloud-machine').filter({ hasText: VM });
  await row.getByRole('button', { name: 'Schlafen legen' }).click();
  await expect.poll(async () => (await machine())?.state, { timeout: 60_000 }).toBe('deallocated');
  expect(fake.power.get(VM)).toBe('deallocated');
  await expect(row).toContainText('Schläft');
  await themes('cloud-asleep');

  const start = await api<{ game: { statusText: string } }>(
    'POST',
    `/api/games/${gameId}/start`,
    {},
  );
  expect(start.status, JSON.stringify(start.data)).toBe(202);
  await expect.poll(() => fake.power.get(VM), { timeout: 30_000 }).toBe('running');
  await expect.poll(async () => (await machine())?.state, { timeout: 90_000 }).toBe('running');
});
