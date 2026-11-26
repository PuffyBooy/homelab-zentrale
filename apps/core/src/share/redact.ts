/** 43+ base64url characters: a share, gateway, agent or session token. */
const TOKEN_RUN = /[A-Za-z0-9_-]{43,}/g;
/** `/s/<anything>` except the API and the assets of the share page. */
const SHARE_PAGE = /^\/+s\/+(?!api(?:[/?#]|$)|assets\/)/i;

function decodeOnce(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * URL for logs: the share page path carries the friend's token, so it is
 * logged as `/s/[redacted]`; any token-like run elsewhere is masked too.
 * Checked on the raw and the percent-decoded URL (the router decodes once).
 */
export function redactShareUrl(url: string): string {
  const decoded = decodeOnce(url);
  if (SHARE_PAGE.test(url) || SHARE_PAGE.test(decoded)) return '/s/[redacted]';
  if (decoded !== url && new RegExp(TOKEN_RUN.source).test(decoded)) {
    return decoded.replace(TOKEN_RUN, '[redacted]');
  }
  return url.replace(TOKEN_RUN, '[redacted]');
}
