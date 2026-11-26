import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gameTemplateSchema, type GameTemplate, type TemplateField } from '@hz/shared';
import { isSafeText } from './safe-text.js';

/**
 * Game templates (SPEC 6.2): templates/games/<id>/template.json + compose.yml.
 * Loaded once at start. Invalid templates are skipped with a log line, so one
 * broken folder never takes the others (or the core) down.
 */

/** Where a placeholder sits in its YAML line; decides how a value is written. */
export type PlaceholderContext =
  /** The whole plain scalar (`KEY: ${X}`, `- ${X}`): written as a double-quoted string. */
  | 'full'
  /** Inside a double-quoted scalar. */
  | 'double'
  /** Inside a single-quoted scalar. */
  | 'single'
  /** Part of a larger plain scalar (`game-${X}`): only a strict charset is allowed. */
  | 'embedded';

export type ComposeToken =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; context: PlaceholderContext; line: number };

export type VarKind =
  | { kind: 'field'; field: TemplateField }
  /** Values the core sets (GAME_NAME, PORT_*). */
  | { kind: 'system' }
  /**
   * Secrets (RCON_PASSWORD, `secret` text fields): never written into compose.yml.
   * The placeholder stays as is; Compose fills it from the folder's .env.
   */
  | { kind: 'secret' };

export interface LoadedTemplate {
  template: GameTemplate;
  /** compose.yml split into literal text and placeholders. */
  tokens: ComposeToken[];
  vars: Map<string, VarKind>;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const MAX_FILE_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const VAR_RE = /^\$\{([A-Z][A-Z0-9_]{0,63})\}/;
/** Text before a placeholder that makes it the whole plain scalar of a mapping or list item. */
const FULL_PREFIX = /^\s*(?:-\s+)?(?:(?:"[^"\\]*"|'[^']*'|[A-Za-z0-9_./-]+)\s*:\s+)?$/;
const FULL_SUFFIX = /^\s*(?:#.*)?$/;

export const portKey = (name: string): string => `PORT_${name.toUpperCase()}`;
export const portEndKey = (name: string): string => `PORT_${name.toUpperCase()}_END`;
export const RCON_PASSWORD_KEY = 'RCON_PASSWORD';
export const RCON_PORT_KEY = 'PORT_RCON';
export const GAME_NAME_KEY = 'GAME_NAME';

/** Every variable a template may use, with its kind. */
export function templateVars(t: GameTemplate): Map<string, VarKind> {
  const vars = new Map<string, VarKind>();
  vars.set(GAME_NAME_KEY, { kind: 'system' });
  for (const p of t.ports) {
    vars.set(portKey(p.name), { kind: 'system' });
    if (p.count > 1) vars.set(portEndKey(p.name), { kind: 'system' });
  }
  if (t.rcon.supported) {
    vars.set(RCON_PORT_KEY, { kind: 'system' });
    vars.set(RCON_PASSWORD_KEY, { kind: 'secret' });
  }
  for (const f of t.fields) {
    if (vars.has(f.key) || f.key.startsWith('PORT_') || f.key === RCON_PASSWORD_KEY) {
      throw new TemplateError(`field ${f.key} collides with a system value`);
    }
    vars.set(
      f.key,
      f.type === 'text' && f.secret ? { kind: 'secret' } : { kind: 'field', field: f },
    );
  }
  return vars;
}

/**
 * Splits compose.yml into text and `${VAR}` placeholders and records the YAML
 * context of each. Full-line comments are dropped. `$$` stays (Compose's escape);
 * any other `$` (also `${X:-default}`, `$X`) is a template error.
 */
export function tokenizeCompose(text: string): ComposeToken[] {
  const tokens: ComposeToken[] = [];
  let pending = '';
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new TemplateError('carriage return in compose.yml');
  const lines = normalized.split('\n');
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/^\s*#/.test(line)) return;
    let state: 'none' | 'double' | 'single' = 'none';
    let i = 0;
    while (i < line.length) {
      const c = line[i] ?? '';
      const next = line[i + 1] ?? '';
      if (state === 'none' && c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
        // Inline comment: kept verbatim, Compose never interpolates comments.
        pending += line.slice(i);
        break;
      }
      if (c === '$') {
        if (next === '$') {
          pending += '$$';
          i += 2;
          continue;
        }
        const m = VAR_RE.exec(line.slice(i));
        if (!m?.[1]) throw new TemplateError(`line ${lineNo}: invalid $ (only \${NAME})`);
        let context: PlaceholderContext;
        if (state === 'none') {
          const before = line.slice(0, i);
          const after = line.slice(i + m[0].length);
          context = FULL_PREFIX.test(before) && FULL_SUFFIX.test(after) ? 'full' : 'embedded';
        } else context = state;
        if (pending !== '') tokens.push({ kind: 'text', text: pending });
        pending = '';
        tokens.push({ kind: 'var', name: m[1], context, line: lineNo });
        i += m[0].length;
        continue;
      }
      if (state === 'none') {
        if (c === '"') state = 'double';
        else if (c === "'") state = 'single';
      } else if (state === 'double') {
        if (c === '\\') {
          pending += c + next;
          i += 2;
          continue;
        }
        if (c === '"') state = 'none';
      } else if (c === "'") {
        if (next === "'") {
          pending += "''";
          i += 2;
          continue;
        }
        state = 'none';
      }
      pending += c;
      i += 1;
    }
    if (state !== 'none') throw new TemplateError(`line ${lineNo}: quoted string spans lines`);
    pending += '\n';
  });
  if (pending !== '') tokens.push({ kind: 'text', text: pending });
  return tokens;
}

function checkPattern(field: TemplateField & { type: 'text' }): void {
  if (field.pattern === undefined) return;
  try {
    new RegExp(`^(?:${field.pattern})$`, 'u');
  } catch {
    throw new TemplateError(`field ${field.key}: invalid pattern`);
  }
}

/** Template rules beyond the JSON schema. Throws TemplateError. */
export function checkTemplate(t: GameTemplate, tokens: ComposeToken[]): Map<string, VarKind> {
  const portNames = new Set<string>();
  for (const p of t.ports) {
    if (portNames.has(p.name)) throw new TemplateError(`port ${p.name} twice`);
    if (p.name === 'rcon') throw new TemplateError('port name rcon is reserved');
    if (p.default + p.count - 1 > 65535) throw new TemplateError(`port ${p.name}: range too large`);
    portNames.add(p.name);
  }
  if (t.query.method !== 'none') {
    if (t.query.port === undefined || !portNames.has(t.query.port)) {
      throw new TemplateError('query.port must name a port');
    }
    if (t.query.method === 'gamedig' && !/^[a-z0-9]{2,40}$/.test(t.query.type ?? '')) {
      throw new TemplateError('query.type required for gamedig');
    }
  }
  if (t.rcon.supported && t.rcon.port === undefined) throw new TemplateError('rcon.port missing');
  if (t.rcon.tpsCommand !== undefined && t.rcon.tpsCommand !== 'tps') {
    throw new TemplateError('rcon.tpsCommand must be "tps"');
  }
  const ramG = (r: string): number => Number(r.slice(0, -1));
  if (ramG(t.ram.min) > ramG(t.ram.recommended)) throw new TemplateError('ram.min > recommended');

  const keys = new Set<string>();
  for (const f of t.fields) {
    if (keys.has(f.key)) throw new TemplateError(`field ${f.key} twice`);
    keys.add(f.key);
    switch (f.type) {
      case 'text':
        checkPattern(f);
        if (!isSafeText(f.default)) throw new TemplateError(`field ${f.key}: unsafe default`);
        if (f.secret && f.default !== '') throw new TemplateError(`field ${f.key}: secret default`);
        break;
      case 'select':
        if (!f.options.includes(f.default)) throw new TemplateError(`field ${f.key}: bad default`);
        if (!f.options.every(isSafeText) || new Set(f.options).size !== f.options.length) {
          throw new TemplateError(`field ${f.key}: bad options`);
        }
        break;
      case 'number':
        if (!Number.isFinite(f.default)) throw new TemplateError(`field ${f.key}: bad default`);
        if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
          throw new TemplateError(`field ${f.key}: min > max`);
        }
        if (
          (f.min !== undefined && f.default < f.min) ||
          (f.max !== undefined && f.default > f.max)
        ) {
          throw new TemplateError(`field ${f.key}: default out of range`);
        }
        break;
      case 'boolean':
        break;
    }
  }

  const vars = templateVars(t);
  const used = new Set<string>();
  for (const tok of tokens) {
    if (tok.kind !== 'var') continue;
    if (!vars.has(tok.name)) throw new TemplateError(`line ${tok.line}: unknown \${${tok.name}}`);
    used.add(tok.name);
  }
  for (const p of t.ports) {
    if (!used.has(portKey(p.name))) throw new TemplateError(`port ${p.name} is not published`);
  }
  // RCON must only ever be published on the loopback interface.
  const text = tokens.map((tok) => (tok.kind === 'text' ? tok.text : `\${${tok.name}}`)).join('');
  // [placeholder, the placeholder that must follow `127.0.0.1:` on the same line]
  const loopbackOnly: [string, string][] = [
    [RCON_PORT_KEY, RCON_PORT_KEY],
    ...t.ports
      .filter((p) => p.local)
      .flatMap((p): [string, string][] => [
        [portKey(p.name), portKey(p.name)],
        [portEndKey(p.name), portKey(p.name)],
      ]),
  ];
  for (const line of text.split('\n')) {
    for (const [key, anchor] of loopbackOnly) {
      if (line.includes(`\${${key}}`) && !line.includes(`127.0.0.1:\${${anchor}}`)) {
        throw new TemplateError(`${key} must be published on 127.0.0.1 only`);
      }
    }
  }
  return vars;
}

/** Parses one template folder. Throws TemplateError. */
export function parseTemplate(id: string, json: string, compose: string): LoadedTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new TemplateError('template.json is not valid JSON');
  }
  const parsed = gameTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TemplateError(
      `template.json: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`,
    );
  }
  const template = parsed.data;
  if (template.id !== id) throw new TemplateError('id does not match the folder name');
  const tokens = tokenizeCompose(compose);
  const vars = checkTemplate(template, tokens);
  return { template, tokens, vars };
}

function readSmall(file: string): string {
  const st = statSync(file);
  if (!st.isFile()) throw new TemplateError(`${file} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw new TemplateError(`${file} is too large`);
  return readFileSync(file, 'utf8');
}

export interface TemplateLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Loads every valid template below `dir`, sorted by name. */
export function loadTemplates(dir: string, log: TemplateLog): Map<string, LoadedTemplate> {
  const out = new Map<string, LoadedTemplate>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    log.warn({ dir }, 'game templates directory not readable');
    return out;
  }
  const loaded: LoadedTemplate[] = [];
  // Dirent.isDirectory() is false for symlinks: only real folders count.
  for (const e of entries
    .filter((d) => d.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!ID_RE.test(e.name)) {
      log.warn({ template: e.name.slice(0, 60) }, 'game template skipped: invalid folder name');
      continue;
    }
    try {
      const json = readSmall(join(dir, e.name, 'template.json'));
      const compose = readSmall(join(dir, e.name, 'compose.yml'));
      loaded.push(parseTemplate(e.name, json, compose));
    } catch (err) {
      const reason = err instanceof TemplateError ? err.message : 'files missing or unreadable';
      log.warn({ template: e.name, reason }, 'game template skipped');
    }
  }
  loaded.sort((a, b) => a.template.name.localeCompare(b.template.name, 'de'));
  for (const l of loaded) out.set(l.template.id, l);
  log.info({ count: out.size, templates: [...out.keys()] }, 'game templates loaded');
  return out;
}
