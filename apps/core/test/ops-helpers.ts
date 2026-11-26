import type { ContainerInfo, ImageScanData, Modules } from '@hz/shared';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { info } from './container-helpers.js';
import { completeSetup, makeApp, type TestApp } from './helpers.js';

export const OPS_ON: Partial<Modules> = { logsearch: true, vulnscan: true, fail2ban: true };

export type Reply = (rpc: Received) => Record<string, unknown> | 'silent' | null;

export const ok = (rpc: Received, data: unknown): Record<string, unknown> => ({
  type: 'rpc.result',
  id: rpc.id,
  ok: true,
  data,
});

export const fail = (rpc: Received, code: string): Record<string, unknown> => ({
  type: 'rpc.result',
  id: rpc.id,
  ok: false,
  error: { code, message: '' },
});

export interface OpsAgent {
  agent: WsClient;
  serverId: string;
  name: string;
  rpcs: Received[];
  /** Replaces the reply function of this agent. */
  reply: Reply;
}

export interface OpsSetup {
  t: TestApp;
  cookie: string;
  secret: string;
  url: string;
  agents: OpsAgent[];
}

export interface ServerSpec {
  name: string;
  containers?: ContainerInfo[];
  reply?: Reply;
}

/**
 * App with the ops modules on (unless `modules` says otherwise), an admin and
 * one enrolled agent per spec. Unanswered RPCs get ok/null.
 */
export async function opsSetup(
  clients: WsClient[],
  opts: { modules?: Partial<Modules>; captureLogs?: boolean; servers?: ServerSpec[] } = {},
): Promise<OpsSetup> {
  const t = await makeApp({
    modules: { ...OPS_ON, ...opts.modules },
    // Tests jump the fake clock by hours; agents must not go stale meanwhile.
    agentOptions: { staleAfterMs: 7 * 24 * 3_600_000 },
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const agents: OpsAgent[] = [];
  const specs = opts.servers ?? [{ name: 'heimserver' }];
  let expected = 0;
  for (const spec of specs) {
    const e = await enrollAgent(t, url, admin.cookie, spec.name);
    clients.push(e.agent);
    const a: OpsAgent = {
      agent: e.agent,
      serverId: e.serverId,
      name: spec.name,
      rpcs: [],
      reply: spec.reply ?? (() => null),
    };
    e.agent.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Received;
      if (m.type !== 'rpc') return;
      a.rpcs.push(m);
      const r = a.reply(m);
      if (r === 'silent') return;
      e.agent.send(r ?? ok(m, null));
    });
    const list = spec.containers ?? [info(`${spec.name}-web`)];
    expected += list.length;
    e.agent.send(inventoryMsg({ containers: list }));
    agents.push(a);
    const want = expected;
    await until(() => t.app.hzCore.containers.list().length === want);
  }
  return { t, url, ...admin, agents };
}

export function scanData(over: Partial<ImageScanData> = {}): ImageScanData {
  return {
    image: 'nginx:1.27',
    digest: `sha256:${'a'.repeat(64)}`,
    scannable: true,
    reason: null,
    counts: { critical: 0, high: 0 },
    vulns: [],
    scannedAt: '2026-11-25T03:30:00.000Z',
    ...over,
  };
}

/** A scan result with `critical` critical and `high` high findings. */
export function vulnData(critical: number, high: number): ImageScanData {
  const vulns = [
    ...Array.from({ length: critical }, (_, i) => ({
      id: `CVE-2026-${1000 + i}`,
      pkg: 'openssl',
      installed: '3.0.1',
      fixed: '3.0.9',
      severity: 'CRITICAL' as const,
      title: 'Bad bug',
    })),
    ...Array.from({ length: high }, (_, i) => ({
      id: `CVE-2026-${2000 + i}`,
      pkg: 'zlib',
      installed: '1.2',
      fixed: null,
      severity: 'HIGH' as const,
      title: 'Less bad bug',
    })),
  ];
  return scanData({ counts: { critical, high }, vulns });
}
