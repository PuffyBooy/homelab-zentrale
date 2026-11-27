import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  TAILSCALE_AUTH_KEY_RE,
  TAILSCALE_DEFAULT_TAG,
  tailscaleClientIdSchema,
  tailscaleClientSecretSchema,
  tailscaleErrorSchema,
  tailscaleTagSchema,
  type TailscaleErrorText,
  type TailscaleSettings,
  type TailscaleSettingsRequest,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { DecryptError, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { readCapped } from '../games/mods.js';

/**
 * M11b: Tailscale OAuth client of the hub, used to mint one single-use auth key per
 * onboarding code (see packages/shared/src/api/tailscale.ts). The client secret is
 * stored with AES-256-GCM (crypto.ts, own AAD); minted keys are never stored.
 */

export const TAILSCALE_API = 'https://api.tailscale.com';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;
const LOOPBACK_OVERRIDE = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;

/** The fixed API host, or a loopback override when HZ_DEMO=1 (tests, e2e). */
export function tailscaleApiBase(config: Pick<Config, 'demo' | 'tailscaleApiOverride'>): string {
  const v = config.tailscaleApiOverride;
  if (!config.demo || v === undefined) return TAILSCALE_API;
  const m = LOOPBACK_OVERRIDE.exec(v);
  const port = Number(m?.[1] ?? 0);
  return m && port >= 1 && port <= 65535 ? v : TAILSCALE_API;
}

export type TailscaleFetch = (url: string, init: RequestInit) => Promise<Response>;

export class TailscaleError extends Error {
  constructor(readonly text: TailscaleErrorText) {
    super(text);
    this.name = 'TailscaleError';
  }
}

export interface TailscaleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface MintedKey {
  id: string;
  key: string;
}

const tokenResponseSchema = z.object({ access_token: z.string().min(8).max(4096) });
const keyResponseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  key: z.string().regex(TAILSCALE_AUTH_KEY_RE),
});

/** Minimal client of the Tailscale API v2 (OAuth client credentials, auth keys). */
export class TailscaleClient {
  constructor(
    private readonly opts: { base: string; fetch?: TailscaleFetch; timeoutMs?: number },
  ) {}

  private async send(path: string, init: RequestInit): Promise<{ status: number; body: string }> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.base}${path}`, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      throw new TailscaleError('Tailscale nicht erreichbar');
    }
    let body: string | null;
    try {
      body = await readCapped(res, MAX_BYTES);
    } catch {
      throw new TailscaleError('Tailscale nicht erreichbar');
    }
    if (body === null) throw new TailscaleError('Unerwartete Antwort von Tailscale');
    return { status: res.status, body };
  }

  private static json(body: string): unknown {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new TailscaleError('Unerwartete Antwort von Tailscale');
    }
  }

  /** Access token of the OAuth client (client credentials). Never logged or returned. */
  async accessToken(c: TailscaleCredentials): Promise<string> {
    if (
      !tailscaleClientIdSchema.safeParse(c.clientId).success ||
      !tailscaleClientSecretSchema.safeParse(c.clientSecret).success
    ) {
      throw new TailscaleError('Client-ID oder Secret falsch');
    }
    const form = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await this.send('/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new TailscaleError('Client-ID oder Secret falsch');
    }
    if (res.status !== 200) throw new TailscaleError('Unerwartete Antwort von Tailscale');
    const p = tokenResponseSchema.safeParse(TailscaleClient.json(res.body));
    if (!p.success) throw new TailscaleError('Unerwartete Antwort von Tailscale');
    return p.data.access_token;
  }

  /**
   * One auth key: single use, preauthorized, not ephemeral (a server stays), tagged
   * (tagged devices have no key expiry), valid `expirySeconds`.
   */
  async createKey(
    token: string,
    opts: { tag: string; expirySeconds: number; description: string },
  ): Promise<MintedKey> {
    if (!tailscaleTagSchema.safeParse(opts.tag).success) {
      throw new TailscaleError('Keine Berechtigung für Auth-Keys oder diesen Tag');
    }
    const res = await this.send('/api/v2/tailnet/-/keys', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: { reusable: false, ephemeral: false, preauthorized: true, tags: [opts.tag] },
          },
        },
        expirySeconds: Math.max(60, Math.round(opts.expirySeconds)),
        description: opts.description.replace(/[^A-Za-z0-9 -]/g, '').slice(0, 50),
      }),
    });
    if (res.status === 401) throw new TailscaleError('Client-ID oder Secret falsch');
    if (res.status === 400 || res.status === 403) {
      throw new TailscaleError('Keine Berechtigung für Auth-Keys oder diesen Tag');
    }
    if (res.status !== 200) throw new TailscaleError('Unerwartete Antwort von Tailscale');
    const p = keyResponseSchema.safeParse(TailscaleClient.json(res.body));
    if (!p.success) throw new TailscaleError('Unerwartete Antwort von Tailscale');
    return p.data;
  }

  async deleteKey(token: string, id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
    const res = await this.send(`/api/v2/tailnet/-/keys/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new TailscaleError('Unerwartete Antwort von Tailscale');
    }
  }
}

const KEY_SETTINGS = 'tailscale.oauth.settings';
const KEY_SECRET = 'tailscale.oauth.clientSecret';
const KEY_STATUS = 'tailscale.oauth.status';
const AAD_SECRET = 'settings.tailscale.oauth.clientSecret';
const UNREADABLE: TailscaleErrorText = 'Zugangsdaten nicht lesbar, bitte neu eintragen';

const storedSchema = z.object({
  clientId: tailscaleClientIdSchema.nullable().catch(null),
  tag: tailscaleTagSchema.catch(TAILSCALE_DEFAULT_TAG),
});
const statusSchema = z.object({
  lastOkAt: z.number().nullable().catch(null),
  error: tailscaleErrorSchema.nullable().catch(null),
});

type Readable<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'unreadable' };

/** Settings + client: what the onboarding route needs. */
export class TailscaleJoin {
  private readonly client: TailscaleClient;

  constructor(
    private readonly deps: {
      db: Db;
      box: SecretBox;
      now: Clock;
      base: string;
      fetch?: TailscaleFetch;
    },
  ) {
    this.client = new TailscaleClient({
      base: deps.base,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  }

  private stored(): z.infer<typeof storedSchema> {
    const p = storedSchema.safeParse(readSetting(this.deps.db, KEY_SETTINGS) ?? {});
    return p.success ? p.data : { clientId: null, tag: TAILSCALE_DEFAULT_TAG };
  }

  private status(): z.infer<typeof statusSchema> {
    const p = statusSchema.safeParse(readSetting(this.deps.db, KEY_STATUS) ?? {});
    return p.success ? p.data : { lastOkAt: null, error: null };
  }

  private secretSet(): boolean {
    return typeof readSetting(this.deps.db, KEY_SECRET) === 'string';
  }

  private credentials(): Readable<TailscaleCredentials> {
    const { clientId } = this.stored();
    const enc = readSetting(this.deps.db, KEY_SECRET);
    if (!clientId || typeof enc !== 'string') return { kind: 'missing' };
    try {
      return {
        kind: 'ok',
        value: { clientId, clientSecret: this.deps.box.decrypt(enc, AAD_SECRET) },
      };
    } catch (err) {
      if (err instanceof DecryptError) return { kind: 'unreadable' };
      throw err;
    }
  }

  /** Client id and secret are stored (the last check may still have failed). */
  configured(): boolean {
    return this.credentials().kind !== 'missing';
  }

  view(): TailscaleSettings {
    const s = this.stored();
    const st = this.status();
    const creds = this.credentials();
    const error = creds.kind === 'unreadable' ? UNREADABLE : st.error;
    let status: TailscaleSettings['status'] = 'off';
    if (creds.kind !== 'missing') status = error !== null ? 'error' : 'ok';
    return {
      clientId: s.clientId,
      secretSet: this.secretSet(),
      tag: s.tag,
      status,
      error: creds.kind === 'missing' ? null : error,
      lastOkAt: st.lastOkAt === null ? null : new Date(st.lastOkAt).toISOString(),
    };
  }

  /** Returns the field names (never values) for the audit log. */
  update(req: TailscaleSettingsRequest): string[] {
    const prev = this.stored();
    const now = this.deps.now();
    const clientChanged = req.clientId !== undefined && req.clientId !== prev.clientId;
    writeSetting(
      this.deps.db,
      KEY_SETTINGS,
      { clientId: req.clientId ?? prev.clientId, tag: req.tag ?? prev.tag },
      now,
    );
    if (req.clientSecret !== undefined) {
      writeSetting(
        this.deps.db,
        KEY_SECRET,
        this.deps.box.encrypt(req.clientSecret, AAD_SECRET),
        now,
      );
    } else if (clientChanged) {
      // A secret is never sent for a client it was not entered for.
      this.deleteKey(KEY_SECRET);
    }
    this.deleteKey(KEY_STATUS);
    return Object.keys(req).sort();
  }

  clear(): void {
    for (const k of [KEY_SETTINGS, KEY_SECRET, KEY_STATUS]) this.deleteKey(k);
  }

  private deleteKey(key: string): void {
    this.deps.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
  }

  private mark(error: TailscaleErrorText | null): void {
    const now = this.deps.now();
    const prev = this.status();
    writeSetting(
      this.deps.db,
      KEY_STATUS,
      { lastOkAt: error === null ? now : prev.lastOkAt, error },
      now,
    );
  }

  /**
   * A fresh key for one onboarding, or null when no client is stored. Throws
   * TailscaleError (status updated) when the API refuses.
   */
  async mint(name: string, expirySeconds: number): Promise<MintedKey | null> {
    const creds = this.credentials();
    if (creds.kind === 'missing') return null;
    if (creds.kind === 'unreadable') {
      this.mark(UNREADABLE);
      throw new TailscaleError(UNREADABLE);
    }
    try {
      const token = await this.client.accessToken(creds.value);
      const key = await this.client.createKey(token, {
        tag: this.stored().tag,
        expirySeconds,
        description: `homelab-zentrale ${name}`,
      });
      this.mark(null);
      return key;
    } catch (err) {
      if (err instanceof TailscaleError) this.mark(err.text);
      throw err;
    }
  }

  /** Best effort: revokes an unused key (cancelled onboarding, test). */
  async revoke(id: string): Promise<void> {
    const creds = this.credentials();
    if (creds.kind !== 'ok') return;
    try {
      const token = await this.client.accessToken(creds.value);
      await this.client.deleteKey(token, id);
    } catch {
      // The key expires with the code anyway.
    }
  }

  /** Settings check: mints a short-lived key and deletes it again. */
  async test(): Promise<TailscaleSettings> {
    try {
      const key = await this.mint('test', 300);
      if (key) await this.revoke(key.id);
    } catch (err) {
      if (!(err instanceof TailscaleError)) throw err;
    }
    return this.view();
  }
}
