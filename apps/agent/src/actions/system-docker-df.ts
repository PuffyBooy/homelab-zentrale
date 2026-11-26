import { dockerDfDataSchema, type DockerDfData } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.dockerDf: Docker disk usage (`docker system df`), read-only.
 *
 * - images: bytes = LayersSize (every layer once, what the images really take);
 *   without it the sum of the unique sizes. unused = images no container uses
 *   (Containers === 0), their unique size (Size - SharedSize), the same figure
 *   system.cleanupPreview shows for docker-images.
 * - containers: writable layers (SizeRw), running = State "running".
 * - volumes: UsageData.Size (-1 = unknown is skipped), unused = RefCount 0.
 *   Volumes are never removed by the agent; the figure is information only.
 * - build cache: Size of all records, unused = not InUse.
 */

interface DfImage {
  Size?: number;
  SharedSize?: number;
  Containers?: number;
}
interface DfContainer {
  State?: string;
  SizeRw?: number;
}
interface DfVolume {
  UsageData?: { Size?: number; RefCount?: number } | null;
}
interface DfBuild {
  Size?: number;
  InUse?: boolean;
}
export interface DockerDfRaw {
  LayersSize?: number;
  Images?: DfImage[] | null;
  Containers?: DfContainer[] | null;
  Volumes?: DfVolume[] | null;
  BuildCache?: DfBuild[] | null;
}

const pos = (n: number | undefined | null): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

export function summarizeDockerDf(df: DockerDfRaw): DockerDfData {
  const images = df.Images ?? [];
  let uniqueSum = 0;
  let unusedCount = 0;
  let unusedBytes = 0;
  for (const img of images) {
    const unique = Math.max(0, pos(img.Size) - pos(img.SharedSize));
    uniqueSum += unique;
    if (img.Containers === 0) {
      unusedCount += 1;
      unusedBytes += unique;
    }
  }
  const layers = pos(df.LayersSize);

  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];
  let volBytes = 0;
  let volUnused = 0;
  let volUnusedBytes = 0;
  for (const v of volumes) {
    const size = pos(v.UsageData?.Size);
    volBytes += size;
    if (v.UsageData?.RefCount === 0) {
      volUnused += 1;
      volUnusedBytes += size;
    }
  }
  const build = df.BuildCache ?? [];

  return dockerDfDataSchema.parse({
    images: {
      count: images.length,
      bytes: layers > 0 ? layers : uniqueSum,
      unusedCount,
      unusedBytes,
    },
    containers: {
      count: containers.length,
      running: containers.filter((c) => c.State === 'running').length,
      bytes: containers.reduce((s, c) => s + pos(c.SizeRw), 0),
    },
    volumes: {
      count: volumes.length,
      bytes: volBytes,
      unusedCount: volUnused,
      unusedBytes: volUnusedBytes,
    },
    buildCache: {
      count: build.length,
      bytes: build.reduce((s, b) => s + pos(b.Size), 0),
      unusedBytes: build.filter((b) => !b.InUse).reduce((s, b) => s + pos(b.Size), 0),
    },
  });
}

export async function systemDockerDf(_p: unknown, ctx: ActionContext): Promise<DockerDfData> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available', false);
  let raw: DockerDfRaw;
  try {
    raw = (await docker.df()) as DockerDfRaw;
  } catch {
    throw new ActionError('failed', 'docker df failed', false);
  }
  return summarizeDockerDf(raw);
}
