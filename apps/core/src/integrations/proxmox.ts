import { z } from 'zod';
import {
  PROXMOX_STEP_UP_ACTIONS,
  proxmoxNodeSchema,
  proxmoxTokenIdSchema,
  type ProxmoxAction,
  type ProxmoxGuest,
  type proxmoxGuestActionParamsSchema,
  type proxmoxGuestsResponseSchema,
  type proxmoxNodeSummarySchema,
} from '@hz/shared';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import { IntegrationService, type IntegrationDeps, type ReadyConfig } from './base.js';
import { IntegrationError, jsonBody, requireOk } from './http.js';
import type { IntegrationConfig } from './store.js';

type NodeSummary = z.infer<typeof proxmoxNodeSummarySchema>;
type GuestsResponse = z.infer<typeof proxmoxGuestsResponseSchema>;
type ActionParams = z.output<typeof proxmoxGuestActionParamsSchema>;

export const PROXMOX_POLL_MS = 30_000;
export const PROXMOX_CACHE_MS = 10_000;
/** Guest actions per minute (all guests together). */
export const PROXMOX_ACTIONS_PER_MIN = 10;
const MAX_NODES = 64;
const MAX_GUESTS = 2000;

export interface ProxmoxData {
  nodes: NodeSummary[];
  guests: ProxmoxGuest[];
}

const num = z.number().finite().min(0).nullable().optional().catch(null);
const resourceSchema = z.object({
  type: z.string(),
  node: z.string().optional().catch(undefined),
  vmid: z.number().int().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  cpu: num,
  maxcpu: num,
  mem: num,
  maxmem: num,
  uptime: num,
  template: z.union([z.number(), z.boolean()]).optional().catch(undefined),
});
const resourcesSchema = z.object({ data: z.array(z.unknown()) });

const GUEST_STATUS = new Set(['running', 'stopped', 'paused']);

/** Parses /cluster/resources; entries with odd node names or types are skipped. */
export function parseResources(body: unknown): ProxmoxData {
  const list = resourcesSchema.safeParse(body);
  if (!list.success) throw new IntegrationError('Unerwartete Antwort');
  const nodes: NodeSummary[] = [];
  const guests: ProxmoxGuest[] = [];
  for (const raw of list.data.data) {
    const p = resourceSchema.safeParse(raw);
    if (!p.success) continue;
    const r = p.data;
    if (r.node === undefined || !proxmoxNodeSchema.safeParse(r.node).success) continue;
    if (r.type === 'node') {
      if (nodes.length >= MAX_NODES) continue;
      nodes.push({
        node: r.node,
        online: r.status === 'online',
        cpu: r.cpu ?? null,
        memBytes: r.mem ?? null,
        maxMemBytes: r.maxmem ?? null,
      });
    } else if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) {
      if (guests.length >= MAX_GUESTS) continue;
      const status = r.status ?? 'unknown';
      guests.push({
        node: r.node,
        type: r.type,
        vmid: r.vmid,
        name: (r.name ?? `${r.vmid}`).slice(0, 120),
        status: GUEST_STATUS.has(status) ? (status as ProxmoxGuest['status']) : 'unknown',
        cpu: r.cpu ?? null,
        cpus: r.maxcpu === null || r.maxcpu === undefined ? null : Math.round(r.maxcpu),
        memBytes: r.mem ?? null,
        maxMemBytes: r.maxmem ?? null,
        uptimeS: r.uptime === null || r.uptime === undefined ? null : Math.floor(r.uptime),
        template: r.template === 1 || r.template === true,
      });
    }
  }
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  guests.sort((a, b) => a.vmid - b.vmid);
  return { nodes, guests };
}

/**
 * Proxmox VE (SPEC 16): VMs and LXC containers of all nodes over an API token,
 * start/shutdown/stop/reboot only for a guest in the last fetched list.
 */
export class ProxmoxService extends IntegrationService<ProxmoxData> {
  private readonly limiter: WindowLimiter;

  constructor(deps: IntegrationDeps) {
    super(deps, 'proxmox', 'Proxmox', PROXMOX_POLL_MS, PROXMOX_CACHE_MS);
    this.limiter = new WindowLimiter(PROXMOX_ACTIONS_PER_MIN, 60_000, deps.now);
  }

  protected override needsUsername(_cfg: IntegrationConfig): boolean {
    return true;
  }

  override ready(): ReadyConfig | null {
    const cfg = super.ready();
    if (cfg === null || !proxmoxTokenIdSchema.safeParse(cfg.username).success) return null;
    return cfg;
  }

  private headers(cfg: ReadyConfig): Record<string, string> {
    return {
      authorization: `PVEAPIToken=${cfg.username ?? ''}=${cfg.secret}`,
      accept: 'application/json',
    };
  }

  protected async fetch(cfg: ReadyConfig): Promise<ProxmoxData> {
    const res = requireOk(
      await this.deps.http.request({
        base: cfg.url,
        path: '/api2/json/cluster/resources',
        headers: this.headers(cfg),
        ca: cfg.caCert,
      }),
    );
    return parseResources(jsonBody(res));
  }

  async guests(): Promise<GuestsResponse> {
    const c = await this.current();
    return {
      nodes: c.data?.nodes ?? [],
      guests: c.data?.guests ?? [],
      fetchedAt: this.iso(c.fetchedAt),
      error: c.error,
    };
  }

  static needsStepUp(action: ProxmoxAction): boolean {
    return PROXMOX_STEP_UP_ACTIONS.includes(action);
  }

  /**
   * Runs a guest action. The guest must be in the last fetched list (node,
   * type and vmid all match), so the path can only name a known guest.
   */
  async action(p: ActionParams): Promise<{ task: string | null; guest: ProxmoxGuest }> {
    if (this.data === null) await this.refresh();
    const guest = this.data?.guests.find(
      (g) => g.node === p.node && g.type === p.type && g.vmid === p.vmid,
    );
    if (!guest) throw new HttpError(404, 'not_found', undefined, 'Gast unbekannt');
    if (guest.template) {
      throw new HttpError(409, 'conflict', undefined, 'Vorlagen lassen sich nicht starten');
    }
    const wait = this.limiter.hit('action');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    const path =
      `/api2/json/nodes/${encodeURIComponent(guest.node)}/${encodeURIComponent(guest.type)}` +
      `/${encodeURIComponent(String(guest.vmid))}/status/${encodeURIComponent(p.action)}`;
    const task = await this.act(async (cfg) => {
      const res = requireOk(
        await this.deps.http.request({
          base: cfg.url,
          path,
          method: 'POST',
          headers: this.headers(cfg),
          ca: cfg.caCert,
        }),
      );
      const body = z.object({ data: z.unknown() }).safeParse(jsonBody(res));
      const upid = body.success ? body.data.data : null;
      return typeof upid === 'string' && upid.length <= 200 && /^UPID:[\x21-\x7e]+$/.test(upid)
        ? upid
        : null;
    });
    this.invalidate();
    return { task, guest };
  }
}
