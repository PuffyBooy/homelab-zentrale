import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  caCertSchema,
  dnsFilterVariantSchema,
  integrationUrlSchema,
  urlOrigin,
  type DnsFilterVariant,
  type IntegrationId,
  type IntegrationSettings,
  type IntegrationSettingsRequest,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { DecryptError, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { IntegrationErrorText } from './http.js';

export const SECRET_UNREADABLE: IntegrationErrorText =
  'Zugangsdaten nicht lesbar, bitte neu eintragen';

const storedSchema = z.object({
  url: integrationUrlSchema.nullable().catch(null),
  username: z.string().max(120).nullable().catch(null),
  variant: dnsFilterVariantSchema.nullable().catch(null),
  caCert: caCertSchema.nullable().catch(null),
});
type Stored = z.infer<typeof storedSchema>;
const EMPTY: Stored = { url: null, username: null, variant: null, caCert: null };

const statusSchema = z.object({ lastOkAt: z.number().nullable().catch(null) });

/** What a request needs. `secret` null: not set or not readable. */
export interface IntegrationConfig {
  url: string | null;
  username: string | null;
  variant: DnsFilterVariant | null;
  caCert: string | null;
  secret: string | null;
  secretSet: boolean;
}

export interface UpdateResult {
  urlChanged: boolean;
  usernameChanged: boolean;
  secretChanged: boolean;
  /**
   * The URL was set for the first time or its origin changed without a new
   * secret in the same request: the stored one is gone.
   */
  secretDropped: boolean;
  caChanged: boolean;
  variantChanged: boolean;
}

/**
 * Key/value storage of one integration in `settings` (no own table):
 * `integration.<id>.settings` (url, username, variant, CA: not secret),
 * `integration.<id>.secret` (AES-256-GCM, AAD `settings.integration.<id>.secret`)
 * and `integration.<id>.status` (last success).
 */
export class IntegrationStore {
  private readonly settingsKey: string;
  private readonly secretKey: string;
  private readonly secretAad: string;
  private readonly statusKey: string;
  private cache: Stored | null = null;

  constructor(
    readonly id: IntegrationId,
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly now: Clock,
  ) {
    this.settingsKey = `integration.${id}.settings`;
    this.secretKey = `integration.${id}.secret`;
    this.secretAad = `settings.integration.${id}.secret`;
    this.statusKey = `integration.${id}.status`;
  }

  private stored(): Stored {
    if (this.cache) return this.cache;
    const p = storedSchema.safeParse(readSetting(this.db, this.settingsKey) ?? {});
    this.cache = p.success ? p.data : EMPTY;
    return this.cache;
  }

  private secretSet(): boolean {
    return typeof readSetting(this.db, this.secretKey) === 'string';
  }

  private secret(): string | null {
    const enc = readSetting(this.db, this.secretKey);
    if (typeof enc !== 'string') return null;
    try {
      return this.box.decrypt(enc, this.secretAad);
    } catch (err) {
      if (err instanceof DecryptError) return null;
      throw err;
    }
  }

  config(): IntegrationConfig {
    const s = this.stored();
    return { ...s, secret: this.secret(), secretSet: this.secretSet() };
  }

  lastOkAt(): number | null {
    const p = statusSchema.safeParse(readSetting(this.db, this.statusKey) ?? {});
    return p.success ? p.data.lastOkAt : null;
  }

  markOk(): void {
    const now = this.now();
    writeSetting(this.db, this.statusKey, { lastOkAt: now }, now);
  }

  /** Public view; status and error come from the service (in memory). */
  view(status: IntegrationSettings['status'], error: string | null): IntegrationSettings {
    const s = this.stored();
    const lastOkAt = this.lastOkAt();
    return {
      url: s.url,
      username: s.username,
      secretSet: this.secretSet(),
      caSet: s.caCert !== null,
      variant: this.id === 'dnsfilter' ? (s.variant ?? 'pihole') : null,
      status,
      error,
      lastOkAt: lastOkAt === null ? null : new Date(lastOkAt).toISOString(),
    };
  }

  update(body: IntegrationSettingsRequest): UpdateResult {
    const prev = this.stored();
    const next: Stored = {
      url: body.url ?? prev.url,
      username: body.username === undefined ? prev.username : body.username,
      variant: body.variant ?? prev.variant,
      caCert: body.caCert === undefined ? prev.caCert : body.caCert,
    };
    const now = this.now();
    writeSetting(this.db, this.settingsKey, next, now);
    this.cache = null;
    // First URL or a new origin: a stored secret was not entered for this host.
    const originChanged =
      next.url !== null && (prev.url === null || urlOrigin(prev.url) !== urlOrigin(next.url));
    let secretDropped = false;
    if (body.secret !== undefined) {
      writeSetting(this.db, this.secretKey, this.box.encrypt(body.secret, this.secretAad), now);
    } else if (originChanged && this.secretSet()) {
      // Never send a token to a host it was not entered for.
      this.deleteKey(this.secretKey);
      secretDropped = true;
    }
    // The last success belongs to the old host.
    if (next.url !== prev.url) this.deleteKey(this.statusKey);
    return {
      urlChanged: next.url !== prev.url,
      usernameChanged: next.username !== prev.username,
      secretChanged: body.secret !== undefined,
      secretDropped,
      caChanged: next.caCert !== prev.caCert,
      variantChanged: next.variant !== prev.variant,
    };
  }

  /** Forgets url, secret, CA and status (DELETE settings). */
  clear(): void {
    for (const k of [this.settingsKey, this.secretKey, this.statusKey]) this.deleteKey(k);
    this.cache = null;
  }

  private deleteKey(key: string): void {
    this.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
  }

  /** Extra per-integration value (not secret), e.g. the Kuma import map. */
  readExtra(name: string): unknown {
    return readSetting(this.db, `integration.${this.id}.${name}`);
  }

  writeExtra(name: string, value: unknown): void {
    writeSetting(this.db, `integration.${this.id}.${name}`, value, this.now());
  }
}
