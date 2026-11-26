import type { GameTemplate, ListeningPort, PortMapping } from '@hz/shared';
import { gigabytes } from '../format.js';
import type { HostPort } from './render.js';

/**
 * Port suggestion and RAM check (SPEC 6.2). Used ports of a server come from the
 * agent's listening ports, the published ports of its containers and the ports
 * of the other game servers on it (whole ranges).
 */

export type Proto = 'tcp' | 'udp';
export interface UsedPorts {
  tcp: Set<number>;
  udp: Set<number>;
}

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
const GIB = 1024 ** 3;

export function protosOf(p: HostPort['protocol']): Proto[] {
  return p === 'tcp+udp' ? ['tcp', 'udp'] : [p];
}

export function emptyUsed(): UsedPorts {
  return { tcp: new Set(), udp: new Set() };
}

export function markUsed(used: UsedPorts, p: Pick<HostPort, 'port' | 'protocol' | 'count'>): void {
  for (const proto of protosOf(p.protocol)) {
    for (let i = 0; i < p.count; i += 1) used[proto].add(p.port + i);
  }
}

export function collectUsed(input: {
  listening: readonly ListeningPort[];
  containerPorts: readonly PortMapping[];
  games: readonly { ports: readonly HostPort[]; rconPort: number | null }[];
}): UsedPorts {
  const used = emptyUsed();
  for (const l of input.listening) used[l.proto].add(l.port);
  for (const c of input.containerPorts) {
    if (c.publicPort !== undefined && (c.proto === 'tcp' || c.proto === 'udp')) {
      used[c.proto].add(c.publicPort);
    }
  }
  for (const g of input.games) {
    for (const p of g.ports) markUsed(used, p);
    if (g.rconPort !== null) used.tcp.add(g.rconPort);
  }
  return used;
}

export function isFree(used: UsedPorts, p: Pick<HostPort, 'port' | 'protocol' | 'count'>): boolean {
  if (p.port < MIN_PORT || p.port + p.count - 1 > MAX_PORT) return false;
  for (const proto of protosOf(p.protocol)) {
    for (let i = 0; i < p.count; i += 1) if (used[proto].has(p.port + i)) return false;
  }
  return true;
}

/** First free start port from `from` upwards, then from 1024; null if none. */
export function firstFree(
  used: UsedPorts,
  from: number,
  protocol: HostPort['protocol'],
  count: number,
): number | null {
  const start = Math.max(MIN_PORT, Math.min(from, MAX_PORT));
  for (let port = start; port + count - 1 <= MAX_PORT; port += 1) {
    if (isFree(used, { port, protocol, count })) return port;
  }
  for (let port = MIN_PORT; port < start; port += 1) {
    if (isFree(used, { port, protocol, count })) return port;
  }
  return null;
}

/** Suggested host port per template port (the next free one from the default). Mutates `used`. */
export function suggestPorts(t: GameTemplate, used: UsedPorts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of t.ports) {
    const port = firstFree(used, p.default, p.protocol, p.count);
    if (port === null) continue;
    out[p.name] = port;
    markUsed(used, { port, protocol: p.protocol, count: p.count });
  }
  return out;
}

/** Host port for RCON (127.0.0.1 only), from the container port upwards. Mutates `used`. */
export function suggestRconPort(t: GameTemplate, used: UsedPorts): number | null {
  if (!t.rcon.supported) return null;
  const port = firstFree(used, Math.max(t.rcon.port ?? 25575, MIN_PORT), 'tcp', 1);
  if (port !== null) used.tcp.add(port);
  return port;
}

/** "6G" -> bytes. */
export function ramBytes(r: string): number {
  return Number(r.slice(0, -1)) * GIB;
}

/** Free RAM against the template recommendation; German warning if too little. */
export function ramCheck(
  ram: { usedBytes: number; totalBytes: number } | null,
  recommended: string,
): { freeRamBytes: number | null; ramWarning: string | null } {
  if (!ram) return { freeRamBytes: null, ramWarning: null };
  const free = Math.max(0, ram.totalBytes - ram.usedBytes);
  const need = ramBytes(recommended);
  return {
    freeRamBytes: free,
    ramWarning:
      free < need
        ? `Zu wenig RAM frei (${gigabytes(free)} frei, ${recommended.slice(0, -1)} GB empfohlen)`
        : null,
  };
}
