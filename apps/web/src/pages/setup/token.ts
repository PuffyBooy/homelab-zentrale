import { setupTokenSchema } from '@hz/shared';

/** Reads `#token=…` from the setup link. Returns null if missing or malformed. */
export function setupTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const parsed = setupTokenSchema.safeParse(params.get('token') ?? '');
  return parsed.success ? parsed.data : null;
}

/** Base32 secret in groups of four for manual entry. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** QR code SVG from the core as an <img> source. Never injected as markup. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
