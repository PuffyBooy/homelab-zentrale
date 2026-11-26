import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import Docker from 'dockerode';
import { containerInfoSchema, type ContainerInfo, type PortMapping } from '@hz/shared';

/**
 * Container list for `inventory` (M2: list only; events follow in M3).
 * Talks to the Docker socket mounted at /var/run/docker.sock.
 */

export async function openDocker(socketPath: string): Promise<Docker | null> {
  try {
    // Read and write: as a non-root user without access we report docker: false.
    await access(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return null;
  }
  return new Docker({ socketPath, timeout: 120_000 });
}

const STATES = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

export function healthFromStatus(status: string): ContainerInfo['health'] {
  if (/\(healthy\)/.test(status)) return 'healthy';
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  return 'none';
}

export function mapContainer(c: Docker.ContainerInfo): ContainerInfo | null {
  const labels = c.Labels ?? {};
  const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
  const exit = /^Exited \((-?\d+)\)/.exec(c.Status ?? '');
  const ports: PortMapping[] = [];
  for (const p of c.Ports ?? []) {
    const proto = p.Type === 'udp' || p.Type === 'sctp' ? p.Type : 'tcp';
    const entry: PortMapping = { privatePort: p.PrivatePort, proto };
    if (p.PublicPort) entry.publicPort = p.PublicPort;
    if (p.IP) entry.ip = p.IP.slice(0, 64);
    ports.push(entry);
  }
  const info: ContainerInfo = {
    dockerId: c.Id,
    name: name.slice(0, 128),
    image: (c.Image ?? '').slice(0, 256),
    state: (STATES.has(c.State) ? c.State : 'dead') as ContainerInfo['state'],
    health: healthFromStatus(c.Status ?? ''),
    statusText: (c.Status ?? '').slice(0, 128),
    ports: ports.slice(0, 64),
  };
  if (c.ImageID) info.imageId = c.ImageID.slice(0, 128);
  const project = labels['com.docker.compose.project'];
  const service = labels['com.docker.compose.service'];
  const dir = labels['com.docker.compose.project.working_dir'];
  if (project) info.composeProject = project.slice(0, 128);
  if (service) info.composeService = service.slice(0, 128);
  if (dir) info.composeDir = dir.slice(0, 512);
  if (exit?.[1]) info.exitCode = Number(exit[1]);
  const parsed = containerInfoSchema.safeParse(info);
  return parsed.success ? parsed.data : null;
}

export async function listContainers(docker: Docker | null): Promise<ContainerInfo[]> {
  if (!docker) return [];
  try {
    const list = await docker.listContainers({ all: true });
    return list
      .map(mapContainer)
      .filter((c): c is ContainerInfo => c !== null)
      .slice(0, 500);
  } catch {
    return [];
  }
}

export async function dockerVersion(docker: Docker | null): Promise<string | undefined> {
  if (!docker) return undefined;
  try {
    const v = await docker.version();
    return v.Version;
  } catch {
    return undefined;
  }
}
