import { imageVersionSchema, type ImageVersion } from '@hz/shared';

/** Subset of `docker image inspect` used for versions. */
export interface ImageMetaLike {
  Id?: string;
  Created?: string;
  Config?: { Labels?: Record<string, string> | null } | null;
}

export const OCI_VERSION = 'org.opencontainers.image.version';
export const OCI_REVISION = 'org.opencontainers.image.revision';
export const OCI_CREATED = 'org.opencontainers.image.created';

const shape = imageVersionSchema.shape;

/** Normalizes a timestamp to ISO UTC; null when it is not a date. */
function isoOrNull(v: string | undefined): string | null {
  if (!v || v.length > 64) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t <= 0) return null;
  const iso = new Date(t).toISOString();
  return shape.created.safeParse(iso).success ? iso : null;
}

/**
 * Version of an image from its OCI labels. Label values that do not match the
 * schema are dropped (a bad label never fails a check). `created` falls back to
 * the image's own Created time. Returns null when the image id is not sha256:<64 hex>.
 */
export function imageVersion(img: ImageMetaLike | null | undefined): ImageVersion | null {
  if (!img?.Id || !shape.imageId.safeParse(img.Id).success) return null;
  const labels = img.Config?.Labels ?? {};
  const out: ImageVersion = { imageId: img.Id };
  const version = labels[OCI_VERSION];
  if (version !== undefined && shape.version.safeParse(version).success) out.version = version;
  const revision = labels[OCI_REVISION]?.toLowerCase();
  if (revision !== undefined && shape.revision.safeParse(revision).success) out.revision = revision;
  const created = isoOrNull(labels[OCI_CREATED]) ?? isoOrNull(img.Created);
  if (created) out.created = created;
  return out;
}
