import net from 'node:net';

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function normalize(addr: string): string | null {
  const a = addr.trim().toLowerCase();
  if (net.isIPv4(a)) return a;
  if (net.isIPv6(a)) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
    return mapped?.[1] ?? a;
  }
  return null;
}

/**
 * Client IP. Caddy runs on the same host and connects over loopback; it sets
 * X-Forwarded-For to the real client address (it ignores incoming values unless
 * trusted_proxies is configured, and appends otherwise). So only when the socket
 * peer is loopback the rightmost X-Forwarded-For entry is used. A header sent by
 * anyone else is ignored.
 */
export function clientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  const socketIp = (remoteAddress && normalize(remoteAddress)) ?? 'unknown';
  if (!isLoopbackAddress(remoteAddress) || forwardedFor === undefined) return socketIp;
  const joined = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const parts = joined.split(',');
  const last = parts[parts.length - 1];
  return (last !== undefined && normalize(last)) || socketIp;
}

/** Rate-limit key: IPv4 address, or the /64 prefix for IPv6 (one host owns a whole /64). */
export function rateLimitKey(ip: string): string {
  if (!net.isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
