import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { shareTokenSchema } from '@hz/shared';

/** Loopback hosts (tests, local development). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The core is only reachable in the tailnet: https on a MagicDNS name (`*.ts.net`,
 * served by `tailscale serve`), or loopback for tests. Returns an error text, never the value.
 */
export function coreUrlProblem(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'HZ_SHARE_CORE_URL ist keine gültige URL';
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    return 'HZ_SHARE_CORE_URL darf keine Zugangsdaten, Query oder Fragment enthalten';
  }
  if (u.pathname !== '/') return 'HZ_SHARE_CORE_URL darf keinen Pfad enthalten';
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && (host.endsWith('.ts.net') || isLoopbackHost(host))) return null;
  if (u.protocol === 'http:' && isLoopbackHost(host)) return null;
  return 'HZ_SHARE_CORE_URL muss https://<name>.ts.net sein (http:// nur für Loopback)';
}

const defaultUiDir = fileURLToPath(new URL('../dist/ui', import.meta.url));

export const configSchema = z.object({
  HZ_SHARE_CORE_URL: z
    .string({ error: 'HZ_SHARE_CORE_URL fehlt' })
    .superRefine((v, ctx) => {
      const problem = coreUrlProblem(v);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .transform((v) => new URL(v).origin),
  HZ_SHARE_GATEWAY_TOKEN: z
    .string({ error: 'HZ_SHARE_GATEWAY_TOKEN fehlt' })
    .refine((v) => shareTokenSchema.safeParse(v).success, {
      message: 'HZ_SHARE_GATEWAY_TOKEN muss 43 Zeichen base64url sein',
    }),
  HZ_SHARE_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  /** Loopback by default: Caddy runs in front on the same host. */
  HZ_SHARE_HOST: z
    .string()
    .default('127.0.0.1')
    .refine((h) => net.isIP(h) !== 0, { message: 'HZ_SHARE_HOST muss eine IP-Adresse sein' }),
  HZ_SHARE_UI_DIR: z.string().min(1).default(defaultUiDir),
  HZ_SHARE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface Config {
  coreUrl: string;
  gatewayToken: string;
  port: number;
  host: string;
  uiDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Validates the environment. Error messages name the variable, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ungültige Konfiguration: ${problems.join('; ')}`);
  }
  const c = parsed.data;
  return {
    coreUrl: c.HZ_SHARE_CORE_URL,
    gatewayToken: c.HZ_SHARE_GATEWAY_TOKEN,
    port: c.HZ_SHARE_PORT,
    host: c.HZ_SHARE_HOST,
    uiDir: c.HZ_SHARE_UI_DIR,
    logLevel: c.HZ_SHARE_LOG_LEVEL,
  };
}
