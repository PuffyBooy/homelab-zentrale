import {
  IMAGE_SCAN_MAX_VULNS,
  TRIVY_IMAGE_DEFAULT,
  imageScanDataSchema,
  pinnedImageRefSchema,
  vulnSchema,
  type ImageScanData,
  type RpcParams,
  type Vuln,
} from '@hz/shared';
import { composeEnv } from './compose.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * image.scan: vulnerability scan of the image a container runs.
 *
 * The agent resolves the registry digest itself (the core never names an image) and
 * runs the pinned Trivy image through the docker CLI with a fixed argument list
 * (trivyArgs). Trivy pulls the image from the registry itself (`--image-src remote`):
 * no Docker socket and no host path is mounted into the scanner; its only writable
 * places are the cache volume hz-trivy-cache and a size-limited /tmp.
 *
 * Images without a registry digest (built locally) are reported as `local_image`.
 */

export const TRIVY_CACHE_VOLUME = 'hz-trivy-cache';
export const SCAN_TIMEOUT_MS = 12 * 60_000;
export const SCAN_MAX_BUFFER = 64 * 1024 * 1024;

/** The fixed docker CLI arguments for one scan. Both refs must be pinned by digest. */
export function trivyArgs(trivyImage: string, ref: string): string[] {
  if (!pinnedImageRefSchema.safeParse(trivyImage).success) {
    throw new ActionError('failed', 'scanner image is not pinned', false);
  }
  if (!pinnedImageRefSchema.safeParse(ref).success) {
    throw new ActionError('invalid_params', 'image ref is not pinned');
  }
  return [
    'run',
    '--rm',
    '--pull',
    'missing',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '1g',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp:rw,size=512m',
    '-v',
    `${TRIVY_CACHE_VOLUME}:/root/.cache`,
    trivyImage,
    'image',
    '--quiet',
    '--format',
    'json',
    '--scanners',
    'vuln',
    '--severity',
    'CRITICAL,HIGH',
    '--image-src',
    'remote',
    '--timeout',
    '10m',
    '--',
    ref,
  ];
}

// ---------------------------------------------------------------------------
// Image reference helpers (pure)

/** Removes a `@digest` and returns repo and tag of an image reference. */
export function splitImageRef(ref: string): { repo: string; tag: string | null } {
  const noDigest = ref.split('@')[0] ?? '';
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon > slash) return { repo: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) };
  return { repo: noDigest, tag: null };
}

/** Docker Hub short form: `docker.io/library/nginx` and `nginx` are the same repo. */
export function normalizeRepo(repo: string): string {
  let r = repo.toLowerCase();
  for (const prefix of ['docker.io/', 'index.docker.io/', 'registry-1.docker.io/']) {
    if (r.startsWith(prefix)) r = r.slice(prefix.length);
  }
  if (r.startsWith('library/') && r.split('/').length === 2) r = r.slice('library/'.length);
  return r;
}

/**
 * Picks the RepoDigest for the container's configured image (else the first) and builds
 * `<repo>[:tag]@sha256:...`. null if there is none or the result is not a pinned ref.
 */
export function pinnedRefFor(
  configImage: string,
  repoDigests: readonly string[],
): { ref: string; digest: string } | null {
  const valid = repoDigests.filter(
    (d) => typeof d === 'string' && /^[^@]+@sha256:[0-9a-f]{64}$/.test(d),
  );
  if (valid.length === 0) return null;
  const want = splitImageRef(configImage);
  const wantRepo = normalizeRepo(want.repo);
  const match = valid.find((d) => normalizeRepo(d.split('@')[0] ?? '') === wantRepo);
  const chosen = match ?? valid[0];
  if (chosen === undefined) return null;
  const [repo = '', digest = ''] = chosen.split('@');
  const tag = match && want.tag ? `:${want.tag}` : '';
  const ref = `${repo}${tag}@${digest}`;
  if (pinnedImageRefSchema.safeParse(ref).success) return { ref, digest };
  // Tag with characters outside the schema: the digest alone is enough.
  const bare = `${repo}@${digest}`;
  return pinnedImageRefSchema.safeParse(bare).success ? { ref: bare, digest } : null;
}

// ---------------------------------------------------------------------------
// Trivy JSON (pure, defensive)

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

function field(o: unknown, key: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
}

/** Parses Trivy's JSON report. Returns null if it is not a Trivy report. */
export function parseTrivyReport(
  json: string,
): { counts: { critical: number; high: number }; vulns: Vuln[] } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const results = field(doc, 'Results');
  if (results !== undefined && results !== null && !Array.isArray(results)) return null;
  const seen = new Set<string>();
  const all: Vuln[] = [];
  for (const result of asArray(results)) {
    for (const v of asArray(field(result, 'Vulnerabilities'))) {
      const severity = field(v, 'Severity');
      if (severity !== 'CRITICAL' && severity !== 'HIGH') continue;
      const id = str(field(v, 'VulnerabilityID'), 64);
      const pkg = str(field(v, 'PkgName'), 200);
      if (id === '' || pkg === '') continue;
      const key = `${id}\u0000${pkg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fixed = str(field(v, 'FixedVersion'), 200);
      const vuln: Vuln = {
        id,
        pkg,
        installed: str(field(v, 'InstalledVersion'), 100),
        fixed: fixed === '' ? null : fixed,
        severity,
        title: str(field(v, 'Title'), 300),
      };
      if (vulnSchema.safeParse(vuln).success) all.push(vuln);
    }
  }
  const critical = all.filter((v) => v.severity === 'CRITICAL').length;
  const high = all.length - critical;
  const rank = (v: Vuln) => (v.severity === 'CRITICAL' ? 0 : 1);
  const vulns = all
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => v)
    .slice(0, IMAGE_SCAN_MAX_VULNS);
  return { counts: { critical, high }, vulns };
}

// ---------------------------------------------------------------------------

/** One scan at a time per agent (Trivy needs up to 1 GiB and the network). */
let scanning = false;

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

function result(
  image: string,
  digest: string | null,
  extra: Pick<ImageScanData, 'scannable' | 'reason' | 'counts' | 'vulns'>,
): ImageScanData {
  return imageScanDataSchema.parse({
    image: image.slice(0, 300),
    digest: digest === null ? null : digest.slice(0, 80),
    ...extra,
    scannedAt: new Date().toISOString(),
  });
}

const NONE = { counts: { critical: 0, high: 0 }, vulns: [] };

export async function imageScan(
  params: RpcParams<'image.scan'>,
  ctx: ActionContext,
): Promise<ImageScanData> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  if (scanning) throw new ActionError('busy', 'another image scan is running', false);
  scanning = true;
  try {
    let configImage: string;
    let imageId: string;
    try {
      const info = await docker.getContainer(params.id).inspect();
      configImage = typeof info.Config?.Image === 'string' ? info.Config.Image : '';
      imageId = typeof info.Image === 'string' ? info.Image : '';
    } catch (err) {
      if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found', false);
      throw new ActionError('failed', 'container inspect failed', false);
    }
    let repoDigests: string[] = [];
    if (imageId !== '') {
      try {
        const img = await docker.getImage(imageId).inspect();
        repoDigests = Array.isArray(img.RepoDigests) ? img.RepoDigests : [];
      } catch (err) {
        if (statusOf(err) !== 404) throw new ActionError('failed', 'image inspect failed', false);
      }
    }
    const pinned = pinnedRefFor(configImage, repoDigests);
    if (!pinned)
      return result(configImage, null, { scannable: false, reason: 'local_image', ...NONE });

    const args = trivyArgs(ctx.trivyImage ?? TRIVY_IMAGE_DEFAULT, pinned.ref);
    const r = await ctx.run('docker', args, {
      timeoutMs: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      env: composeEnv(ctx.dockerSocket),
    });
    const report = r.code === 0 ? parseTrivyReport(r.stdout) : null;
    if (!report) {
      ctx.log.warn('image scan failed', {
        container: params.id,
        code: r.code,
        error: r.error,
        stderr: r.stderr.trim().split('\n').slice(-5).join(' | ').slice(-500),
      });
      return result(configImage, pinned.digest, {
        scannable: false,
        reason: 'scan_failed',
        ...NONE,
      });
    }
    return result(configImage, pinned.digest, { scannable: true, reason: null, ...report });
  } finally {
    scanning = false;
  }
}
