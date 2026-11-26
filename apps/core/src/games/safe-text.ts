/** Max length of a text value (gameCreateRequestSchema allows 200). */
export const MAX_TEXT_CHARS = 200;

/**
 * Characters a template value may never contain: control and format characters
 * (newlines, NUL, bidi marks), line/paragraph separators, unassigned or private
 * code points, `$` (Compose interpolation), quotes, backslash and backtick.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Cs}$"'\\`]/u;

export function isSafeText(v: string): boolean {
  return v.length <= MAX_TEXT_CHARS && !FORBIDDEN.test(v);
}
