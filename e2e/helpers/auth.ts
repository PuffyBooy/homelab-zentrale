import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { E2E_SETUP_TOKEN } from '../../playwright.config.js';

/**
 * Shared login for e2e specs. The core wipes test-results/data when it starts, so the
 * admin is created once per run (by whichever spec comes first) and its TOTP secret is
 * kept next to the DB. Codes are single-use, so the last used 30-s step is kept too.
 */

export const ORIGIN = 'http://127.0.0.1:8099';
export const USER = 'alex';
export const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const STATE_FILE = 'test-results/data/e2e-admin.json';

interface AdminState {
  secret: string;
  lastStep: number;
}

function readState(): AdminState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as AdminState;
  } catch {
    return null;
  }
}

function writeState(s: AdminState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

/** TOTP generator that never hands out the same 30-s step twice (also across spec files). */
export class Totp {
  private readonly totp: TOTP;

  constructor(readonly secret: string) {
    this.totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const s = readState();
    if (!s || s.secret !== secret) writeState({ secret, lastStep: -1 });
  }

  /** Current code without marking it used (for "wrong code" tests). */
  peek(): string {
    return this.totp.generate();
  }

  async fresh(): Promise<string> {
    const lastStep = readState()?.lastStep ?? -1;
    let step = Math.floor(Date.now() / 1000 / this.totp.period);
    if (step <= lastStep) {
      const wait = (lastStep + 1) * this.totp.period * 1000 - Date.now() + 250;
      await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
      step = Math.floor(Date.now() / 1000 / this.totp.period);
    }
    writeState({ secret: this.secret, lastStep: step });
    return this.totp.generate();
  }
}

/** Secret of the admin created earlier in this run, if any. */
export function savedTotp(): Totp | null {
  const s = readState();
  return s ? new Totp(s.secret) : null;
}

/** First setup through the UI. Returns the TOTP of the new admin. */
export async function setupAdmin(page: Page): Promise<Totp> {
  await page.goto(`/setup#token=${E2E_SETUP_TOKEN}`);
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Passwort wiederholen').fill(PASSWORD);
  await page.getByRole('button', { name: 'Weiter' }).click();
  const secret = await page.getByTestId('totp-secret').getAttribute('data-secret');
  const totp = new Totp(secret ?? '');
  await page.getByLabel('Code aus der App').fill(await totp.fresh());
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await page.getByRole('button', { name: 'Ich habe sie gesichert' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  return totp;
}

export async function login(page: Page, totp: Totp): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Benutzername').fill(USER);
  await page.getByLabel('Passwort').fill(PASSWORD);
  await page.getByLabel('Code').fill(await totp.fresh());
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/** Makes sure an admin exists and `page` is signed in. */
export async function signIn(page: Page): Promise<Totp> {
  const res = await page.request.get('/api/auth/state');
  const state = (await res.json()) as { setupRequired: boolean; authenticated: boolean };
  if (state.setupRequired) return setupAdmin(page);
  const totp = savedTotp();
  if (!totp) throw new Error(`admin exists but ${STATE_FILE} is missing; restart the core`);
  if (!state.authenticated) await login(page, totp);
  return totp;
}

/** Answers the step-up dialog if it shows up. */
export async function answerStepUp(page: Page, totp: Totp): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Mit Code bestätigen' });
  await dialog.getByLabel('Code').fill(await totp.fresh());
  await dialog.getByRole('button', { name: 'Bestätigen' }).click();
}
