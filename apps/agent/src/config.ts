import os from 'node:os';
import { z } from 'zod';
import {
  HOMELAB_ROOT,
  TRIVY_IMAGE_DEFAULT,
  agentNameSchema,
  agentTokenSchema,
  pinnedImageRefSchema,
} from '@hz/shared';

const boolFlag = z
  .enum(['0', '1', 'true', 'false'])
  .default('0')
  .transform((v) => v === '1' || v === 'true');

/** Tailnet or loopback hosts may use plain ws:// (Tailscale already encrypts). */
export function isTrustedPlainHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true;
  // Tailscale CGNAT range 100.64.0.0/10 and the Tailscale IPv6 ULA prefix.
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  if (h.startsWith('fd7a:115c:a1e0:')) return true;
  // MagicDNS: short names (no dot) and *.ts.net.
  if (!h.includes('.') && !h.includes(':')) return true;
  return h.endsWith('.ts.net');
}

/** Returns an error text for a bad core URL, or null. Never includes the value. */
export function coreUrlProblem(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'HZ_CORE_URL ist keine gültige URL';
  }
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.pathname.endsWith('/agent')) {
    return 'HZ_CORE_URL muss ws:// oder wss:// sein und auf /agent enden';
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    return 'HZ_CORE_URL darf keine Zugangsdaten, Query oder Fragment enthalten';
  }
  if (u.protocol === 'ws:' && !isTrustedPlainHost(u.hostname)) {
    return 'HZ_CORE_URL: ws:// nur für Loopback oder Tailnet-Adressen, sonst wss://';
  }
  return null;
}

const coreUrl = z.string({ error: 'HZ_CORE_URL fehlt' }).superRefine((v, ctx) => {
  const problem = coreUrlProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

function defaultName(): string | undefined {
  const h = os.hostname().toLowerCase();
  return agentNameSchema.safeParse(h).success ? h : undefined;
}

export const configSchema = z.object({
  HZ_CORE_URL: coreUrl,
  /** Enrollment token (first start) or agent token. Optional once /data/agent.json exists. */
  HZ_AGENT_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(agentTokenSchema.optional()),
  HZ_AGENT_NAME: agentNameSchema.optional(),
  HZ_AGENT_ALLOW_TERMINAL: boolFlag,
  /** M13: read SMART with smartctl (needs deploy/docker-compose.agent.smart.yml). */
  HZ_AGENT_SMART: boolFlag,
  HZ_AGENT_DATA: z.string().min(1).default('/data'),
  /** How host commands run: nsenter (container, default in the image), direct (bare host), none. */
  HZ_AGENT_HOST_EXEC: z.enum(['nsenter', 'direct', 'none']).default('direct'),
  /** Host /proc (mounted at /host/proc in the container). */
  HZ_AGENT_HOST_PROC: z.string().min(1).default('/proc'),
  /** Where the host's root file system is visible ("/" on the host, /host/proc/1/root in the container). */
  HZ_AGENT_HOST_ROOT: z.string().min(1).default('/'),
  HZ_AGENT_DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
  /** Only for tests (NODE_ENV=test). */
  HZ_AGENT_HOMELAB_ROOT: z.string().min(2).optional(),
  /** Trivy image for image.scan; must be pinned (`repo[:tag]@sha256:...`), else the default is used. */
  HZ_AGENT_TRIVY_IMAGE: z.string().optional(),
  HZ_AGENT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export interface AgentConfig {
  coreUrl: string;
  token: string | undefined;
  name: string;
  allowTerminal: boolean;
  smart: boolean;
  dataDir: string;
  hostExec: 'nsenter' | 'direct' | 'none';
  hostProc: string;
  hostRoot: string;
  dockerSocket: string;
  homelabRoot: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Pinned Trivy image for image.scan. */
  trivyImage: string;
  /** HZ_AGENT_TRIVY_IMAGE was set but not a pinned ref; trivyImage is the default (log a warning). */
  trivyImageRejected: boolean;
}

/** HZ_AGENT_TRIVY_IMAGE -> pinned image; anything not pinned by digest falls back to the default. */
export function resolveTrivyImage(v: string | undefined): { image: string; rejected: boolean } {
  if (v === undefined || v === '') return { image: TRIVY_IMAGE_DEFAULT, rejected: false };
  return pinnedImageRefSchema.safeParse(v).success
    ? { image: v, rejected: false }
    : { image: TRIVY_IMAGE_DEFAULT, rejected: true };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses the environment. Messages name the variable and the rule, never the value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => {
        const key = i.path.join('.');
        // zod messages for tokens could echo patterns only, but keep it generic.
        return key === 'HZ_AGENT_TOKEN'
          ? 'HZ_AGENT_TOKEN: ungültiges Format'
          : `${key}: ${i.message}`;
      }),
    );
  }
  const c = parsed.data;
  const name = c.HZ_AGENT_NAME ?? defaultName();
  if (name === undefined) {
    throw new ConfigError(['HZ_AGENT_NAME fehlt (Hostname ist kein gültiger Name)']);
  }
  if (c.HZ_AGENT_HOMELAB_ROOT !== undefined && c.NODE_ENV !== 'test') {
    throw new ConfigError(['HZ_AGENT_HOMELAB_ROOT: nur mit NODE_ENV=test erlaubt']);
  }
  const trivy = resolveTrivyImage(c.HZ_AGENT_TRIVY_IMAGE);
  return {
    coreUrl: c.HZ_CORE_URL,
    token: c.HZ_AGENT_TOKEN,
    name,
    allowTerminal: c.HZ_AGENT_ALLOW_TERMINAL,
    smart: c.HZ_AGENT_SMART,
    dataDir: c.HZ_AGENT_DATA,
    hostExec: c.HZ_AGENT_HOST_EXEC,
    hostProc: c.HZ_AGENT_HOST_PROC,
    hostRoot: c.HZ_AGENT_HOST_ROOT,
    dockerSocket: c.HZ_AGENT_DOCKER_SOCKET,
    homelabRoot: c.HZ_AGENT_HOMELAB_ROOT ?? HOMELAB_ROOT,
    logLevel: c.HZ_AGENT_LOG_LEVEL,
    trivyImage: trivy.image,
    trivyImageRejected: trivy.rejected,
  };
}
