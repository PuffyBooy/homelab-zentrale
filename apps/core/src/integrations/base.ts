import type { FastifyBaseLogger } from 'fastify';
import type { IntegrationId, IntegrationSettings, IntegrationSettingsRequest } from '@hz/shared';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { clockTime } from '../format.js';
import { HttpError } from '../http/errors.js';
import { errorTextFor, IntegrationError, type IntegrationHttp } from './http.js';
import {
  IntegrationStore,
  SECRET_UNREADABLE,
  type IntegrationConfig,
  type UpdateResult,
} from './store.js';

/** Unreachable for longer than this: one warn alert per integration. */
export const INTEGRATION_ALERT_AFTER_MS = 5 * 60_000;

export interface IntegrationDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  alerts: AlertService;
  http: IntegrationHttp;
  log: FastifyBaseLogger;
}

/** A configuration complete enough for requests. */
export interface ReadyConfig {
  url: string;
  username: string | null;
  secret: string;
  caCert: string | null;
  variant: IntegrationConfig['variant'];
}

export const unreachableAlertKey = (id: IntegrationId): string => `integration:${id}:unreachable`;

/**
 * Shared part of every integration: settings, status (ok/error/off), polling
 * while the module is on and configured, the "nicht erreichbar" alert after
 * 5 min, and a generation counter so a result of an old configuration is
 * never applied after the settings changed.
 */
export abstract class IntegrationService<TData> {
  readonly store: IntegrationStore;
  protected data: TData | null = null;
  protected fetchedAt: number | null = null;
  private error: string | null = null;
  private errorSince: number | null = null;
  private lastAttempt: number | null = null;
  private inflight: Promise<void> | null = null;
  private readonly actions = new Set<Promise<unknown>>();
  protected generation = 0;
  private active = false;

  constructor(
    protected readonly deps: IntegrationDeps,
    readonly id: IntegrationId,
    /** German name for alerts and messages ("Proxmox"). */
    readonly label: string,
    private readonly pollMs: number,
    /** GET routes reuse data younger than this. */
    private readonly cacheMs: number,
  ) {
    this.store = new IntegrationStore(id, deps.db, deps.box, deps.now);
  }

  /** One full fetch of the data shown on the page. */
  protected abstract fetch(cfg: ReadyConfig): Promise<TData>;

  /** Configuration changed or module off: drop sessions etc. */
  protected onReset(): void {
    // Subclasses with session state override this.
  }

  /** Called after each successful fetch (e.g. the internet alert). */
  protected afterFetch(_data: TData): void {
    // Subclasses with extra alerts override this.
  }

  /** Extra alerts of the integration to resolve when it is switched off or cleared. */
  protected extraAlertKeys(): string[] {
    return [];
  }

  /** Needs a user name besides the secret. */
  protected needsUsername(_cfg: IntegrationConfig): boolean {
    return false;
  }

  isEnabled(): boolean {
    return this.active;
  }

  setEnabled(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.reset();
  }

  /** null: not configured (or the secret cannot be decrypted). */
  ready(): ReadyConfig | null {
    const c = this.store.config();
    if (c.url === null || c.secret === null) return null;
    if (this.needsUsername(c) && c.username === null) return null;
    return {
      url: c.url,
      username: c.username,
      secret: c.secret,
      caCert: c.caCert,
      variant: c.variant,
    };
  }

  private secretUnreadable(): boolean {
    const c = this.store.config();
    return c.secretSet && c.secret === null;
  }

  status(): IntegrationSettings['status'] {
    if (this.secretUnreadable()) return 'error';
    if (this.ready() === null) return 'off';
    if (this.error !== null) return 'error';
    // Configured and not failed: ok once a request ever succeeded.
    return this.fetchedAt !== null || this.store.lastOkAt() !== null ? 'ok' : 'off';
  }

  currentError(): string | null {
    if (this.secretUnreadable()) return SECRET_UNREADABLE;
    if (this.ready() === null) return null;
    return this.error;
  }

  settings(): IntegrationSettings {
    const status = this.status();
    return this.store.view(status, status === 'error' ? this.currentError() : null);
  }

  /** Stores the settings; a change of anything a request uses runs one fetch now. */
  async updateSettings(body: IntegrationSettingsRequest): Promise<UpdateResult> {
    const r = this.store.update(body);
    if (
      r.urlChanged ||
      r.usernameChanged ||
      r.secretChanged ||
      r.secretDropped ||
      r.caChanged ||
      r.variantChanged
    ) {
      this.reset();
      if (this.active && this.ready() !== null) await this.refresh();
    }
    return r;
  }

  clear(): void {
    this.store.clear();
    this.reset();
  }

  /** POST /test: one request now. */
  async test(): Promise<IntegrationSettings> {
    if (this.ready() !== null) await this.refresh();
    return this.settings();
  }

  private resolveAlerts(): void {
    for (const key of [unreachableAlertKey(this.id), ...this.extraAlertKeys()]) {
      const a = this.deps.alerts.active(key);
      if (a) this.deps.alerts.resolveById(a.id);
    }
  }

  private reset(): void {
    this.generation++;
    // A fetch of the old configuration may still run; it is discarded, the next one starts fresh.
    this.inflight = null;
    this.data = null;
    this.fetchedAt = null;
    this.error = null;
    this.errorSince = null;
    this.lastAttempt = null;
    this.onReset();
    // Switched off or reconfigured: the old condition is gone, no "wieder erreichbar".
    this.resolveAlerts();
  }

  /** Fetches now (joins a running fetch). Never throws. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.runFetch().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async runFetch(): Promise<void> {
    const cfg = this.active ? this.ready() : null;
    if (cfg === null) return;
    const gen = this.generation;
    this.lastAttempt = this.deps.now();
    try {
      const data = await this.fetch(cfg);
      if (gen !== this.generation) return;
      this.data = data;
      this.fetchedAt = this.deps.now();
      this.onSuccess();
      this.afterFetch(data);
    } catch (err) {
      if (gen !== this.generation) return;
      if (!(err instanceof IntegrationError)) {
        this.deps.log.error(
          { integration: this.id, err: err instanceof Error ? { name: err.name } : 'error' },
          'integration fetch failed',
        );
      }
      this.onFailure(errorTextFor(err));
    }
  }

  protected onSuccess(): void {
    const wasDown = this.error !== null;
    this.error = null;
    this.errorSince = null;
    this.store.markOk();
    if (wasDown) this.deps.log.info({ integration: this.id }, 'integration reachable');
    if (this.deps.alerts.active(unreachableAlertKey(this.id))) {
      this.deps.alerts.resolve(unreachableAlertKey(this.id), {
        title: `${this.label} wieder erreichbar`,
        body: `Seit ${clockTime(this.deps.now())} wieder erreichbar.`,
      });
    }
  }

  protected onFailure(text: string): void {
    if (this.error !== text) {
      this.deps.log.info({ integration: this.id, error: text }, 'integration request failed');
    }
    this.error = text;
    this.errorSince ??= this.deps.now();
  }

  /** Data for a GET route: fresh enough, or fetched now. */
  async current(): Promise<{ data: TData | null; fetchedAt: number | null; error: string | null }> {
    // A failed attempt counts too: a GET must not hammer a host that is down.
    const fresh = this.lastAttempt !== null && this.deps.now() - this.lastAttempt < this.cacheMs;
    if (!fresh) await this.refresh();
    return { data: this.data, fetchedAt: this.fetchedAt, error: this.currentError() };
  }

  /** Every second: poll when due, raise the alert after 5 min. */
  tick(): void {
    if (!this.active || this.ready() === null) return;
    const now = this.deps.now();
    if (
      this.inflight === null &&
      (this.lastAttempt === null || now - this.lastAttempt >= this.pollMs)
    ) {
      void this.refresh();
    }
    if (
      this.error !== null &&
      this.errorSince !== null &&
      now - this.errorSince > INTEGRATION_ALERT_AFTER_MS
    ) {
      this.deps.alerts.raise(
        unreachableAlertKey(this.id),
        'warn',
        `${this.label} nicht erreichbar`,
        `Seit ${clockTime(this.errorSince)} keine Antwort (${this.error}).`,
        null,
        'system',
      );
    }
  }

  /** Resolves once running fetches and actions are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight !== null || this.actions.size > 0) {
      await Promise.allSettled([this.inflight, ...this.actions]);
    }
  }

  /**
   * Runs an action against the remote system with the current configuration.
   * Not configured: 409. Remote failure: 502 with the fixed text (and the
   * status turns to error).
   */
  protected async act<T>(fn: (cfg: ReadyConfig) => Promise<T>): Promise<T> {
    const cfg = this.ready();
    if (cfg === null) {
      throw new HttpError(409, 'conflict', undefined, `${this.label} ist nicht eingerichtet`);
    }
    const gen = this.generation;
    const p = fn(cfg);
    this.actions.add(p);
    try {
      return await p;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const text = errorTextFor(err);
      if (gen === this.generation) this.onFailure(text);
      throw new HttpError(502, 'internal', undefined, `${this.label}: ${text}`);
    } finally {
      this.actions.delete(p);
    }
  }

  protected iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
  }

  /** Marks the data stale, so the next GET fetches again. */
  protected invalidate(): void {
    this.lastAttempt = null;
  }
}
