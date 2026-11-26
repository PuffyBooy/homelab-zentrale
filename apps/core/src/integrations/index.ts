import type { IntegrationId, ModuleId } from '@hz/shared';
import type { CheckService } from '../checks/service.js';
import type { IntegrationDeps, IntegrationService } from './base.js';
import { DnsFilterService } from './dnsfilter.js';
import { FritzService } from './fritzbox.js';
import { IntegrationHttp, type IntegrationHttpOptions } from './http.js';
import { ProxmoxService } from './proxmox.js';
import { KumaService } from './uptimekuma.js';

export interface IntegrationsDeps extends Omit<IntegrationDeps, 'http'> {
  checks: Pick<CheckService, 'create' | 'validate' | 'row'>;
  httpOptions?: IntegrationHttpOptions;
}

/** The four integrations of M14, one module each (same id). */
export class Integrations {
  readonly http: IntegrationHttp;
  readonly proxmox: ProxmoxService;
  readonly dnsfilter: DnsFilterService;
  readonly fritzbox: FritzService;
  readonly uptimekuma: KumaService;

  constructor(deps: IntegrationsDeps) {
    this.http = new IntegrationHttp(deps.httpOptions);
    const base: IntegrationDeps = {
      db: deps.db,
      box: deps.box,
      now: deps.now,
      alerts: deps.alerts,
      log: deps.log,
      http: this.http,
    };
    this.proxmox = new ProxmoxService(base);
    this.dnsfilter = new DnsFilterService(base);
    this.fritzbox = new FritzService(base);
    this.uptimekuma = new KumaService(base, deps.checks);
  }

  all(): IntegrationService<unknown>[] {
    return [this.proxmox, this.dnsfilter, this.fritzbox, this.uptimekuma];
  }

  get(id: IntegrationId): IntegrationService<unknown> {
    return this[id];
  }

  /** Module switch: the module id equals the integration id. */
  setModule(id: ModuleId, on: boolean): boolean {
    const svc = this.all().find((s) => s.id === id);
    if (!svc) return false;
    svc.setEnabled(on);
    return true;
  }

  tick(): void {
    for (const s of this.all()) s.tick();
  }

  async idle(): Promise<void> {
    await Promise.all(this.all().map((s) => s.idle()));
  }
}
