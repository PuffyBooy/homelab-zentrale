import path from 'node:path';
import type Docker from 'dockerode';
import type { HostExec } from './exec.js';

/**
 * Everything the collectors and actions need to see the host.
 *
 * In the container (deploy/docker-compose.agent.yml):
 * - hostProc = /host/proc (host /proc, read-only bind mount; with `pid: host`
 *   /host/proc/1 is the host's init),
 * - hostRoot = /host/proc/1/root (host root file system as seen by init; needs
 *   CAP_SYS_PTRACE and an unconfined AppArmor profile),
 * - exec = nsenter into host PID 1's namespaces.
 * On a bare host: hostProc = /proc, hostRoot = /, exec = direct.
 */
export interface HostContext {
  hostProc: string;
  hostRoot: string;
  exec: HostExec;
  docker: Docker | null;
}

/** Maps an absolute host path to where the agent can read it. */
export function hostPath(ctx: Pick<HostContext, 'hostRoot'>, p: string): string {
  return path.join(ctx.hostRoot, p);
}

/** Node arch names to the names Docker/Debian use. */
export function normalizeArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64';
    case 'arm':
      return 'armhf';
    default:
      return arch;
  }
}
