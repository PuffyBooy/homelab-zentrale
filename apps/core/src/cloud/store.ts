import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  azureRegionSchema,
  azureResourceGroupSchema,
  CLOUD_BUDGET_DEFAULT_EUR,
  CLOUD_ERRORS,
  type AzureRegion,
  type AzureSettings,
  type AzureSettingsRequest,
  type CloudErrorText,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { DecryptError, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { AzureCredentials } from './azure.js';

export const UNREADABLE: CloudErrorText = 'Zugangsdaten nicht lesbar, bitte neu eintragen';

const KEY_SETTINGS = 'cloud.azure.settings';
const KEY_SECRET = 'cloud.azure.clientSecret';
const KEY_TAILSCALE = 'cloud.azure.tailscaleAuthKey';
const KEY_STATUS = 'cloud.azure.status';
/** AAD per field: a ciphertext cannot be moved to another setting. */
const AAD_SECRET = 'settings.cloud.azure.clientSecret';
const AAD_TAILSCALE = 'settings.cloud.azure.tailscaleAuthKey';

const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .nullable()
  .catch(null);

const storedSchema = z.object({
  tenantId: guid,
  clientId: guid,
  subscriptionId: guid,
  resourceGroup: azureResourceGroupSchema.nullable().catch(null),
  region: azureRegionSchema.catch('germanywestcentral'),
  budgetEurPerMonth: z.number().min(1).max(10_000).catch(CLOUD_BUDGET_DEFAULT_EUR),
});
type Stored = z.infer<typeof storedSchema>;

const statusSchema = z.object({
  lastOkAt: z.number().nullable().catch(null),
  error: z.enum(CLOUD_ERRORS).nullable().catch(null),
});
type Status = z.infer<typeof statusSchema>;

export type Readable<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'unreadable' };

export interface SettingsChange {
  /** Field names of the request (never values). */
  fields: string[];
  /** Tenant, app or subscription changed without a new secret: the stored one is gone. */
  secretDropped: boolean;
  /** Something the Azure login or the resource path depends on changed. */
  accessChanged: boolean;
}

/**
 * Azure account of the cloud module in `settings` (no own table):
 * `cloud.azure.settings` (tenant, app, subscription, group, region, budget: not secret),
 * `cloud.azure.clientSecret` and `cloud.azure.tailscaleAuthKey` (AES-256-GCM via
 * crypto.ts, AAD per field), `cloud.azure.status` (last check).
 */
export class AzureAccountStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly now: Clock,
  ) {}

  stored(): Stored {
    const p = storedSchema.safeParse(readSetting(this.db, KEY_SETTINGS) ?? {});
    if (p.success) return p.data;
    return storedSchema.parse({});
  }

  region(): AzureRegion {
    return this.stored().region;
  }

  budget(): number {
    return this.stored().budgetEurPerMonth;
  }

  private status(): Status {
    const p = statusSchema.safeParse(readSetting(this.db, KEY_STATUS) ?? {});
    return p.success ? p.data : { lastOkAt: null, error: null };
  }

  private isSet(key: string): boolean {
    return typeof readSetting(this.db, key) === 'string';
  }

  private decrypt(key: string, aad: string): Readable<string> {
    const enc = readSetting(this.db, key);
    if (typeof enc !== 'string') return { kind: 'missing' };
    try {
      return { kind: 'ok', value: this.box.decrypt(enc, aad) };
    } catch (err) {
      if (err instanceof DecryptError) return { kind: 'unreadable' };
      throw err;
    }
  }

  /** Complete account: tenant, app, secret, subscription and resource group. */
  credentials(): Readable<AzureCredentials> {
    const s = this.stored();
    if (!s.tenantId || !s.clientId || !s.subscriptionId || !s.resourceGroup) {
      return { kind: 'missing' };
    }
    const secret = this.decrypt(KEY_SECRET, AAD_SECRET);
    if (secret.kind !== 'ok') return secret;
    return {
      kind: 'ok',
      value: {
        tenantId: s.tenantId,
        clientId: s.clientId,
        clientSecret: secret.value,
        subscriptionId: s.subscriptionId,
        resourceGroup: s.resourceGroup,
      },
    };
  }

  tailscaleKey(): Readable<string> {
    return this.decrypt(KEY_TAILSCALE, AAD_TAILSCALE);
  }

  tailscaleKeySet(): boolean {
    return this.isSet(KEY_TAILSCALE);
  }

  markOk(): void {
    const now = this.now();
    writeSetting(this.db, KEY_STATUS, { lastOkAt: now, error: null }, now);
  }

  markError(text: CloudErrorText): void {
    const now = this.now();
    writeSetting(this.db, KEY_STATUS, { lastOkAt: this.status().lastOkAt, error: text }, now);
  }

  view(): AzureSettings {
    const s = this.stored();
    const st = this.status();
    const creds = this.credentials();
    const complete = creds.kind === 'ok';
    const error: CloudErrorText | null = creds.kind === 'unreadable' ? UNREADABLE : st.error;
    let status: AzureSettings['status'] = 'off';
    if (error !== null && (complete || creds.kind === 'unreadable')) status = 'error';
    else if (complete && st.lastOkAt !== null) status = 'ok';
    return {
      tenantId: s.tenantId,
      clientId: s.clientId,
      subscriptionId: s.subscriptionId,
      resourceGroup: s.resourceGroup,
      region: s.region,
      secretSet: this.isSet(KEY_SECRET),
      tailscaleKeySet: this.isSet(KEY_TAILSCALE),
      budgetEurPerMonth: s.budgetEurPerMonth,
      status: complete || creds.kind === 'unreadable' ? status : 'off',
      error: complete || creds.kind === 'unreadable' ? error : null,
      lastOkAt: st.lastOkAt === null ? null : new Date(st.lastOkAt).toISOString(),
    };
  }

  /** Which identity/path fields of a request differ from the stored ones. */
  changes(req: AzureSettingsRequest): {
    tenant: boolean;
    client: boolean;
    subscription: boolean;
    group: boolean;
  } {
    const s = this.stored();
    return {
      tenant: req.tenantId !== undefined && req.tenantId !== s.tenantId,
      client: req.clientId !== undefined && req.clientId !== s.clientId,
      subscription: req.subscriptionId !== undefined && req.subscriptionId !== s.subscriptionId,
      group: req.resourceGroup !== undefined && req.resourceGroup !== s.resourceGroup,
    };
  }

  update(req: AzureSettingsRequest): SettingsChange {
    const prev = this.stored();
    const ch = this.changes(req);
    const next: Stored = {
      tenantId: req.tenantId ?? prev.tenantId,
      clientId: req.clientId ?? prev.clientId,
      subscriptionId: req.subscriptionId ?? prev.subscriptionId,
      resourceGroup: req.resourceGroup ?? prev.resourceGroup,
      region: req.region ?? prev.region,
      budgetEurPerMonth: req.budgetEurPerMonth ?? prev.budgetEurPerMonth,
    };
    const now = this.now();
    writeSetting(this.db, KEY_SETTINGS, next, now);
    let secretDropped = false;
    if (req.clientSecret !== undefined) {
      writeSetting(this.db, KEY_SECRET, this.box.encrypt(req.clientSecret, AAD_SECRET), now);
    } else if ((ch.tenant || ch.client || ch.subscription) && this.isSet(KEY_SECRET)) {
      // Never send a secret for an app or subscription it was not entered for.
      this.deleteKey(KEY_SECRET);
      secretDropped = true;
    }
    if (req.tailscaleAuthKey !== undefined) {
      writeSetting(
        this.db,
        KEY_TAILSCALE,
        this.box.encrypt(req.tailscaleAuthKey, AAD_TAILSCALE),
        now,
      );
    }
    const accessChanged =
      ch.tenant || ch.client || ch.subscription || ch.group || req.clientSecret !== undefined;
    // The last check belongs to the old account.
    if (accessChanged) this.deleteKey(KEY_STATUS);
    return {
      fields: Object.keys(req).sort(),
      secretDropped,
      accessChanged,
    };
  }

  clear(): void {
    for (const k of [KEY_SETTINGS, KEY_SECRET, KEY_TAILSCALE, KEY_STATUS]) this.deleteKey(k);
  }

  private deleteKey(key: string): void {
    this.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
  }
}
