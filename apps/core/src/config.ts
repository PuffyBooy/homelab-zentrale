import { z } from 'zod';

const boolFlag = z
  .enum(['0', '1', 'true', 'false'])
  .default('0')
  .transform((v) => v === '1' || v === 'true');

/** `.env.example` ships `HZ_VAPID_PUBLIC=` etc. empty: treat empty as unset. */
const optionalEnv = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

const secretKey = z
  .string({ error: 'HZ_SECRET_KEY fehlt' })
  .min(1, 'HZ_SECRET_KEY fehlt')
  .refine(
    (v) => base64.test(v) && Buffer.from(v, 'base64').length === 32,
    'HZ_SECRET_KEY muss 32 Byte als Base64 sein (openssl rand -base64 32)',
  );

export const configSchema = z.object({
  HZ_SECRET_KEY: secretKey,
  HZ_DATA_DIR: z.string().min(1).default('./data'),
  // 127.0.0.1 outside Docker. 0.0.0.0 only inside the core container, whose port is
  // published on 127.0.0.1 only (deploy/docker-compose.core.yml). See docs/NETWORK.md.
  HZ_HOST: z.ipv4().default('127.0.0.1'),
  HZ_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HZ_BASE_URL: z.url().optional(),
  HZ_WEB_DIR: z.string().min(1).optional(),
  HZ_DEMO: boolFlag,
  // Agent image shown in the enrollment one-liner (same variable and default as
  // deploy/docker-compose.agent.yml).
  HZ_AGENT_IMAGE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._/:@-]{0,254}$/, 'HZ_AGENT_IMAGE: ungültiger Image-Name')
    .default('homelab-zentrale/agent:local'),
  // Game templates (templates/games/<id>/). Default: the repo's templates dir; the
  // Docker image sets it to the copy shipped in the image.
  HZ_GAME_TEMPLATES_DIR: optionalEnv(z.string().min(1).max(4096)),
  // Fixed setup token, only for automated tests (e2e). Rejected unless NODE_ENV=test.
  HZ_SETUP_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22,128}$/, 'HZ_SETUP_TOKEN: 22-128 Zeichen [A-Za-z0-9_-]')
    .optional(),
  // Optional fixed VAPID key pair for Web Push (base64url, as from
  // `npx web-push generate-vapid-keys`). Without it the core generates one on
  // first start and stores it encrypted in the database.
  HZ_VAPID_PUBLIC: optionalEnv(
    z.string().regex(/^[A-Za-z0-9_-]{80,100}$/, 'HZ_VAPID_PUBLIC: ungültiger Schlüssel'),
  ),
  HZ_VAPID_PRIVATE: optionalEnv(
    z.string().regex(/^[A-Za-z0-9_-]{40,50}$/, 'HZ_VAPID_PRIVATE: ungültiger Schlüssel'),
  ),
  // Contact for push services (VAPID "sub"): mailto: or https URL.
  HZ_VAPID_SUBJECT: optionalEnv(
    z
      .string()
      .max(200)
      .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'HZ_VAPID_SUBJECT: mailto: oder https://'),
  ),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export interface Config {
  secretKey: Buffer;
  dataDir: string;
  host: string;
  port: number;
  baseUrl: string | undefined;
  webDir: string | undefined;
  demo: boolean;
  agentImage: string;
  /** templates/games directory; undefined = the repo default (app.ts). */
  gameTemplatesDir: string | undefined;
  env: 'development' | 'production' | 'test';
  /** Only set with NODE_ENV=test. */
  setupToken: string | undefined;
  /** Fixed VAPID keys from the environment (both or none). */
  vapid: { publicKey: string; privateKey: string } | undefined;
  vapidSubject: string | undefined;
}

export function isLoopback(host: string): boolean {
  return host.startsWith('127.');
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates the environment. Issue messages only name the variable
 * and the rule, never the received value, so secrets never end up in logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const c = parsed.data;
  if (c.HZ_SETUP_TOKEN !== undefined && c.NODE_ENV !== 'test') {
    throw new ConfigError(['HZ_SETUP_TOKEN: nur mit NODE_ENV=test erlaubt']);
  }
  if ((c.HZ_VAPID_PUBLIC === undefined) !== (c.HZ_VAPID_PRIVATE === undefined)) {
    throw new ConfigError(['HZ_VAPID_PUBLIC und HZ_VAPID_PRIVATE nur gemeinsam setzen']);
  }
  return {
    secretKey: Buffer.from(c.HZ_SECRET_KEY, 'base64'),
    dataDir: c.HZ_DATA_DIR,
    host: c.HZ_HOST,
    port: c.HZ_PORT,
    baseUrl: c.HZ_BASE_URL,
    webDir: c.HZ_WEB_DIR,
    demo: c.HZ_DEMO,
    agentImage: c.HZ_AGENT_IMAGE,
    gameTemplatesDir: c.HZ_GAME_TEMPLATES_DIR,
    env: c.NODE_ENV,
    setupToken: c.HZ_SETUP_TOKEN,
    vapid:
      c.HZ_VAPID_PUBLIC !== undefined && c.HZ_VAPID_PRIVATE !== undefined
        ? { publicKey: c.HZ_VAPID_PUBLIC, privateKey: c.HZ_VAPID_PRIVATE }
        : undefined,
    vapidSubject: c.HZ_VAPID_SUBJECT,
  };
}
