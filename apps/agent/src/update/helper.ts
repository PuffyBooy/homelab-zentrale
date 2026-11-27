import type Docker from 'dockerode';
import { ROLE_LABEL } from '../actions/protected.js';
import type { UpdateInspect } from '../actions/container-update.js';

/**
 * M17: the short-lived helper container that replaces the agent.
 *
 * The agent cannot recreate its own container (stopping the old one ends the
 * process doing the work), so it starts this helper and lets it do the swap
 * (src/updater.ts). Rights, minimal:
 * - Image: the CURRENT agent image by id (known good, contains dist/updater.js);
 *   a broken new image can never run the rollback.
 * - Mounts: exactly two. The Docker socket (to rename/create/stop/start/remove
 *   the agent container; this is root-equivalent, like the agent's own socket)
 *   and the agent's /data volume (to write the result file for the next agent).
 * - No network (the socket is a unix socket), read-only root file system, every
 *   capability dropped, no-new-privileges, not privileged, small
 *   memory and pid limits. RestartPolicy on-failure (max 3) instead of AutoRemove, so a
 *   crashed helper resumes from its journal (journal.ts); the agent removes it later.
 * - User: the owner of /data, so it can write the result there without
 *   DAC_OVERRIDE; the socket's group is added so it can reach Docker. Only when
 *   the socket is not group-writable it runs as root with DAC_OVERRIDE alone.
 * - Label hz.role=updater: protected like core and agent (container.* refuses it).
 * Nothing from the core reaches it besides the run id (validated).
 */

export const HELPER_SOCKET = '/var/run/docker.sock';
export const HELPER_DATA = '/data';

export interface HelperInput {
  runId: string;
  /** The running agent container. */
  agent: UpdateInspect;
  /** Image id the tag points to after the pull. */
  newImageId: string;
  /** Docker socket path inside the agent container (HZ_AGENT_DOCKER_SOCKET). */
  dockerSocket: string;
  /** Data dir inside the agent container (HZ_AGENT_DATA). */
  dataDir: string;
  /** stat() of the data dir and the socket inside the agent container. */
  dataOwner: { uid: number; gid: number };
  socket: { gid: number; mode: number };
  now?: () => number;
}

interface MountLike {
  Type: string;
  Name?: string;
  Source?: string;
  Destination: string;
}

const SAFE_SOURCE = /^[A-Za-z0-9/_.@-]{1,255}$/;

/** Host side of the mount at `dest` of the agent container (volume name or bind path). */
export function mountSource(info: UpdateInspect, dest: string): string | null {
  const mounts = (info.Mounts ?? []) as MountLike[];
  const m = mounts.find((x) => x.Destination === dest);
  if (!m) return null;
  const src = m.Type === 'volume' ? m.Name : m.Type === 'bind' ? m.Source : undefined;
  if (!src || !SAFE_SOURCE.test(src) || src.includes('..')) return null;
  return src;
}

export function helperName(runId: string): string {
  return `hz-updater-${runId}`.slice(0, 100);
}

export function buildHelperCreate(i: HelperInput): Docker.ContainerCreateOptions {
  const socketSrc = mountSource(i.agent, i.dockerSocket);
  const dataSrc = mountSource(i.agent, i.dataDir);
  if (!socketSrc) throw new Error('docker socket mount of the agent not found');
  if (!dataSrc) throw new Error('data volume of the agent not found');

  const groupWritable = (i.socket.mode & 0o060) === 0o060;
  const asOwner = i.dataOwner.uid !== 0 && groupWritable;
  const host: Docker.HostConfig = {
    // Restarted after a crash so it can finish or undo the swap from its journal;
    // the agent removes the exited helper afterwards (UpdateService.reconcile).
    RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
    Binds: [`${socketSrc}:${HELPER_SOCKET}`, `${dataSrc}:${HELPER_DATA}`],
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    NetworkMode: 'none',
    Memory: 256 * 1024 * 1024,
    PidsLimit: 64,
    LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
  };
  let user: string;
  if (i.dataOwner.uid === 0) {
    // Root owns /data (and normally the socket): no capability needed.
    user = '0:0';
  } else if (asOwner) {
    user = `${i.dataOwner.uid}:${i.dataOwner.gid}`;
    host.GroupAdd = [String(i.socket.gid)];
  } else {
    user = '0:0';
    host.CapAdd = ['DAC_OVERRIDE'];
  }
  return {
    name: helperName(i.runId),
    Image: i.agent.Image,
    Cmd: ['node', 'dist/updater.js'],
    WorkingDir: '/app',
    User: user,
    Env: [
      'NODE_ENV=production',
      `HZ_UPDATER_TARGET=${i.agent.Id}`,
      `HZ_UPDATER_RUN_ID=${i.runId}`,
      `HZ_UPDATER_IMAGE=${i.newImageId}`,
      `HZ_UPDATER_DATA=${HELPER_DATA}`,
    ],
    Labels: { [ROLE_LABEL]: 'updater', 'hz.update.run': i.runId },
    // The image's check means "agent connected"; it says nothing about the helper.
    Healthcheck: { Test: ['NONE'] },
    HostConfig: host,
  };
}
