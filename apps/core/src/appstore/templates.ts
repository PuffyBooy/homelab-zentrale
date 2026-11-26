import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  APP_COMPOSE_MAX_BYTES,
  APP_RESERVED_KEYS,
  appTemplateIdSchema,
  appTemplateMetaSchema,
  type AppTemplateMeta,
} from '@hz/shared';
import { analyzeCompose, type ComposeAnalysis, type PortProto } from './compose-check.js';
import { valueProblem } from './render.js';

/**
 * Stack templates (M21): built-in ones from templates/apps/<id>/{template.json,
 * compose.yml}, loaded once at start (a broken folder is skipped and logged),
 * custom ones from the table app_templates. Both pass the same checks.
 */

export type AppTemplateSource = 'builtin' | 'custom';

export interface AppTemplate {
  source: AppTemplateSource;
  meta: AppTemplateMeta;
  /** compose.yml with placeholders, as in the template. */
  compose: string;
}

const MAX_JSON_BYTES = 64 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
/** templates/apps of the repo, seen from apps/core/src/appstore or apps/core/dist/appstore. */
export const REPO_APP_TEMPLATES_DIR = resolve(here, '../../../../templates/apps');
/** Copy shipped in the core image. */
export const IMAGE_APP_TEMPLATES_DIR = '/app/templates/apps';

const envDirSchema = z.string().min(1).max(4096).optional();

/**
 * Directory of the built-in templates: deps (tests) > HZ_APP_TEMPLATES_DIR >
 * /app/templates/apps when present (image) > the repo's templates/apps.
 */
export function appTemplatesDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override !== undefined) return resolve(override);
  const raw = env.HZ_APP_TEMPLATES_DIR;
  const parsed = envDirSchema.safeParse(raw === '' ? undefined : raw);
  if (parsed.success && parsed.data !== undefined) return resolve(parsed.data);
  if (existsSync(IMAGE_APP_TEMPLATES_DIR)) return IMAGE_APP_TEMPLATES_DIR;
  return REPO_APP_TEMPLATES_DIR;
}

/** Placeholders and port parameters a template's compose.yml may use. */
export function templateKeys(meta: AppTemplateMeta): {
  keys: Set<string>;
  portKeys: Map<string, PortProto>;
} {
  const keys = new Set<string>(APP_RESERVED_KEYS);
  const portKeys = new Map<string, PortProto>();
  for (const p of meta.params) {
    keys.add(p.key);
    if (p.type === 'port') portKeys.set(p.key, p.protocol);
  }
  return { keys, portKeys };
}

/**
 * Keys Compose itself reads from .env (COMPOSE_FILE, COMPOSE_PROJECT_NAME, …,
 * DOCKER_HOST) or that the agent's own environment sets and that would take
 * precedence over .env during interpolation (HZ_AGENT_TOKEN, PATH, …).
 */
const HOST_ENV_PREFIXES = ['COMPOSE_', 'DOCKER_', 'BUILDKIT_', 'HZ_', 'NODE_'];
const HOST_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'HOSTNAME', 'LANG']);
export const isHostEnvKey = (k: string): boolean =>
  HOST_ENV_KEYS.has(k) || HOST_ENV_PREFIXES.some((p) => k.startsWith(p));

/** Rules of the metadata beyond the zod schema (German problems). */
export function metaProblems(meta: AppTemplateMeta): string[] {
  const out: string[] = [];
  const ports = new Set<string>();
  for (const p of meta.params) {
    if (isHostEnvKey(p.key)) {
      out.push(`Parameter ${p.key}: Name ist reserviert (COMPOSE_, DOCKER_, HZ_ …)`);
    }
    switch (p.type) {
      case 'string':
        if (p.pattern !== undefined) {
          try {
            new RegExp(`^(?:${p.pattern})$`, 'u');
          } catch {
            out.push(`Parameter ${p.key}: ungültiges Muster`);
            break;
          }
        }
        if (p.default !== undefined && p.default !== '') {
          const prob = valueProblem(p.default);
          if (prob) out.push(`Parameter ${p.key}: Standardwert ${prob}`);
          else if (
            p.pattern !== undefined &&
            !new RegExp(`^(?:${p.pattern})$`, 'u').test(p.default)
          ) {
            out.push(`Parameter ${p.key}: Standardwert passt nicht zum Muster`);
          }
        }
        break;
      case 'number':
        if (p.min > p.max) out.push(`Parameter ${p.key}: min ist größer als max`);
        else if (p.default < p.min || p.default > p.max) {
          out.push(`Parameter ${p.key}: Standardwert außerhalb von min und max`);
        }
        break;
      case 'select': {
        const values = p.options.map((o) => o.value);
        if (new Set(values).size !== values.length)
          out.push(`Parameter ${p.key}: doppelte Auswahl`);
        if (!values.includes(p.default))
          out.push(`Parameter ${p.key}: Standardwert ist keine Auswahl`);
        break;
      }
      case 'port': {
        const k = `${p.protocol}/${p.default}`;
        if (ports.has(k)) out.push(`Parameter ${p.key}: Port ${p.default} doppelt`);
        ports.add(k);
        break;
      }
      case 'password':
      case 'bool':
        break;
    }
  }
  return out;
}

export interface TemplateCheck extends ComposeAnalysis {
  /** compose problems plus metadata problems. */
  problems: string[];
}

/** Metadata rules plus compose safety check of the (unrendered) template. */
export function checkTemplate(meta: AppTemplateMeta, compose: string): TemplateCheck {
  const { keys, portKeys } = templateKeys(meta);
  const a = analyzeCompose(compose, { keys, portKeys });
  return { ...a, problems: [...metaProblems(meta), ...a.problems] };
}

export class AppTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppTemplateError';
  }
}

/** Opens once without following symlinks, checks and reads from the same handle. */
function readSmall(file: string, max: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AppTemplateError('not a file');
    if (st.size > max) throw new AppTemplateError('file too large');
    const buf = Buffer.alloc(max + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > max) throw new AppTemplateError('file too large');
    }
    return buf.subarray(0, len).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Parses one built-in template folder. Throws AppTemplateError (message without file content). */
export function parseBuiltin(id: string, json: string, compose: string): AppTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AppTemplateError('template.json is not valid JSON');
  }
  const parsed = appTemplateMetaSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppTemplateError(
      `template.json: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`.slice(
        0,
        200,
      ),
    );
  }
  if (parsed.data.id !== id) throw new AppTemplateError('id does not match the folder name');
  const check = checkTemplate(parsed.data, compose);
  if (check.problems.length > 0) {
    throw new AppTemplateError(
      `unsafe or invalid: ${check.problems.slice(0, 3).join('; ')}`.slice(0, 400),
    );
  }
  return { source: 'builtin', meta: parsed.data, compose };
}

export interface TemplateLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Loads every valid built-in template below `dir`, sorted by name. */
export function loadBuiltinTemplates(dir: string, log: TemplateLog): Map<string, AppTemplate> {
  const out = new Map<string, AppTemplate>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    log.warn({ dir }, 'app templates directory not readable');
    return out;
  }
  const loaded: AppTemplate[] = [];
  // Dirent.isDirectory() is false for symlinks: only real folders count.
  for (const e of entries
    .filter((d) => d.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!appTemplateIdSchema.safeParse(e.name).success) {
      log.warn({ template: e.name.slice(0, 60) }, 'app template skipped: invalid folder name');
      continue;
    }
    try {
      const json = readSmall(join(dir, e.name, 'template.json'), MAX_JSON_BYTES);
      const compose = readSmall(join(dir, e.name, 'compose.yml'), APP_COMPOSE_MAX_BYTES);
      loaded.push(parseBuiltin(e.name, json, compose));
    } catch (err) {
      const reason = err instanceof AppTemplateError ? err.message : 'files missing or unreadable';
      log.warn({ template: e.name, reason }, 'app template skipped');
    }
  }
  loaded.sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'de'));
  for (const l of loaded) out.set(l.meta.id, l);
  log.info({ count: out.size, templates: [...out.keys()] }, 'app templates loaded');
  return out;
}
