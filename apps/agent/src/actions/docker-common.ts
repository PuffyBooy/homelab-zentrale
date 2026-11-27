import { isProtectedContainer } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * Shared helpers of the M23 Docker actions (container-remove.ts, container-inspect.ts,
 * docker-resources.ts, stack.ts).
 *
 * Error messages are fixed English texts. Docker's own error text is never passed
 * on: it may echo env values, registry URLs with credentials or paths.
 */

/** The subset of dockerode's container list entry the M23 actions read. */
export interface ListedContainer {
  Id: string;
  Names?: string[] | null;
  Image?: string;
  ImageID?: string;
  State?: string;
  Labels?: Record<string, string> | null;
  Mounts?: { Type?: string; Name?: string; Source?: string }[] | null;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string } | null> | null;
  } | null;
}

export interface ListDocker {
  listContainers(opts: { all: boolean; filters?: string }): Promise<unknown[]>;
}

export function statusOf(err: unknown): number | undefined {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

/** ctx.host.docker or `failed` (no audit event: a server without Docker is no attack). */
export function dockerOf<T>(ctx: ActionContext): T {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available', false);
  return docker as unknown as T;
}

/** Container name without Docker's leading slash. */
export function containerName(c: Pick<ListedContainer, 'Names' | 'Id'>): string {
  const n = c.Names?.find((x) => typeof x === 'string' && x.length > 0);
  return (n ? n.replace(/^\//, '') : c.Id.slice(0, 12)).slice(0, 256);
}

export function isProtectedListed(c: ListedContainer): boolean {
  return isProtectedContainer({ id: c.Id, labels: c.Labels });
}

/** Every container (any state). */
export async function allContainers(docker: ListDocker): Promise<ListedContainer[]> {
  try {
    const list = (await docker.listContainers({ all: true })) as ListedContainer[];
    return Array.isArray(list) ? list.filter((c) => typeof c?.Id === 'string') : [];
  } catch {
    throw new ActionError('failed', 'listing containers failed', false);
  }
}

export const NOT_ALLOWED_PROTECTED = 'used by the agent or the core, cannot be removed';

/** Rejects after `ms` (the timer does not keep the process alive). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error('failed'));
      },
    );
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Docker's "never" timestamp and unparsable values become null; everything else ISO. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.startsWith('0001-01-01')) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Unix seconds (images) to ISO. */
export function isoFromUnix(v: unknown): string {
  const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  return new Date(n * 1000).toISOString();
}

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
export const COMPOSE_WORKDIR_LABEL = 'com.docker.compose.project.working_dir';
export const COMPOSE_FILES_LABEL = 'com.docker.compose.project.config_files';

export function labelOf(
  labels: Record<string, string> | null | undefined,
  key: string,
  max = 100,
): string | null {
  const v = labels?.[key];
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}
