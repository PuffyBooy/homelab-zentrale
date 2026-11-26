import type { GameTemplate } from '@hz/shared';
import { isSafeText } from './safe-text.js';
import {
  GAME_NAME_KEY,
  RCON_PASSWORD_KEY,
  RCON_PORT_KEY,
  portEndKey,
  portKey,
  type LoadedTemplate,
  type PlaceholderContext,
} from './templates.js';

/**
 * Rendering of compose.yml and .env from validated values. Values never carry
 * characters that could leave their YAML scalar or .env line: no control or
 * format characters (newlines, NUL, bidi marks), no `$` (Compose interpolation),
 * no quotes, backslash or backtick. Secrets never go into compose.yml.
 */

export type FieldValue = string | number | boolean;

export class ValueError extends Error {
  constructor(
    /** Field key (never the value). */
    readonly key: string,
    readonly reason: string,
  ) {
    super(`${key}: ${reason}`);
    this.name = 'ValueError';
  }
}

/** Values inside a larger plain scalar (`game-${X}`). */
const EMBED_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** .env values that need no quotes. */
const ENV_PLAIN_RE = /^[A-Za-z0-9._/:@+,-]*$/;

export interface HostPort {
  name: string;
  port: number;
  protocol: GameTemplate['ports'][number]['protocol'];
  count: number;
}

export interface ValidatedValues {
  /** Non-secret field values (stored in settings_json, shown in the API). */
  values: Record<string, FieldValue>;
  /** Secret text fields (stored encrypted, only written to .env). */
  secrets: Record<string, string>;
}

/**
 * Checks `input` against the template fields: unknown keys, types, select
 * options, number min/max, text pattern and length, safe characters. Missing
 * keys take `previous` (settings update) or the template default.
 */
export function validateValues(
  t: GameTemplate,
  input: Record<string, unknown>,
  previous?: ValidatedValues,
): ValidatedValues {
  const fields = new Map(t.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(input)) {
    if (!fields.has(key)) throw new ValueError(key.slice(0, 64), 'unknown field');
  }
  const values: Record<string, FieldValue> = {};
  const secrets: Record<string, string> = {};
  for (const f of t.fields) {
    const has = Object.hasOwn(input, f.key);
    const isSecret = f.type === 'text' && f.secret === true;
    const prev = isSecret ? previous?.secrets[f.key] : previous?.values[f.key];
    const v: unknown = has ? input[f.key] : (prev ?? f.default);
    switch (f.type) {
      case 'text': {
        if (typeof v !== 'string') throw new ValueError(f.key, 'must be text');
        if (!isSafeText(v)) throw new ValueError(f.key, 'invalid characters or too long');
        if (v === '' && !f.optional && !isSecret) throw new ValueError(f.key, 'required');
        if (v !== '' && f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`, 'u').test(v)) {
          throw new ValueError(f.key, 'does not match the pattern');
        }
        if (isSecret) {
          if (v === '' && !f.optional) throw new ValueError(f.key, 'required');
          secrets[f.key] = v;
        } else values[f.key] = v;
        break;
      }
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) {
          throw new ValueError(f.key, 'must be a number');
        }
        if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
          throw new ValueError(f.key, 'out of range');
        }
        values[f.key] = v;
        break;
      }
      case 'select':
        if (typeof v !== 'string' || !f.options.includes(v)) {
          throw new ValueError(f.key, 'not an option');
        }
        values[f.key] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw new ValueError(f.key, 'must be true or false');
        values[f.key] = v;
        break;
    }
  }
  return { values, secrets };
}

export interface RenderInput {
  name: string;
  ports: readonly HostPort[];
  rconPort: number | null;
  values: ValidatedValues;
  rconPassword: string | null;
}

/** All variables (system values, fields and secrets) for .env. */
function allVars(l: LoadedTemplate, input: RenderInput): Map<string, FieldValue> {
  const out = new Map<string, FieldValue>();
  out.set(GAME_NAME_KEY, input.name);
  for (const p of l.template.ports) {
    const host = input.ports.find((x) => x.name === p.name);
    if (!host) throw new ValueError(portKey(p.name), 'port missing');
    out.set(portKey(p.name), host.port);
    if (p.count > 1) out.set(portEndKey(p.name), host.port + p.count - 1);
  }
  if (l.template.rcon.supported) {
    if (input.rconPort === null || input.rconPassword === null) {
      throw new ValueError(RCON_PORT_KEY, 'rcon missing');
    }
    out.set(RCON_PORT_KEY, input.rconPort);
    out.set(RCON_PASSWORD_KEY, input.rconPassword);
  }
  for (const [k, v] of Object.entries(input.values.values)) out.set(k, v);
  for (const [k, v] of Object.entries(input.values.secrets)) out.set(k, v);
  return out;
}

function formatValue(key: string, v: FieldValue, context: PlaceholderContext): string {
  const text = String(v);
  // Defense in depth: values were validated, but never write anything unsafe.
  if (!isSafeText(text)) throw new ValueError(key, 'invalid characters or too long');
  switch (context) {
    case 'full':
      return typeof v === 'number' ? text : `"${text}"`;
    case 'double':
    case 'single':
      return text;
    case 'embedded':
      if (!EMBED_RE.test(text)) throw new ValueError(key, 'not allowed at this place');
      return text;
  }
}

/** compose.yml with every non-secret placeholder replaced. Secret placeholders stay for Compose. */
export function renderCompose(l: LoadedTemplate, input: RenderInput): string {
  const vars = allVars(l, input);
  let out = '';
  for (const tok of l.tokens) {
    if (tok.kind === 'text') {
      out += tok.text;
      continue;
    }
    const kind = l.vars.get(tok.name);
    if (!kind) throw new ValueError(tok.name, 'unknown placeholder');
    if (kind.kind === 'secret') {
      out += `\${${tok.name}}`;
      continue;
    }
    const v = vars.get(tok.name);
    if (v === undefined) throw new ValueError(tok.name, 'no value');
    out += formatValue(tok.name, v, tok.context);
  }
  return out;
}

/** .env of the game folder (Compose interpolation and `env_file`). Contains the secrets. */
export function renderEnv(l: LoadedTemplate, input: RenderInput): string {
  const lines = ['# Written by homelab-zentrale. Contains secrets; do not edit or share.'];
  for (const [k, v] of allVars(l, input)) {
    const text = String(v);
    if (!isSafeText(text)) throw new ValueError(k, 'invalid characters or too long');
    lines.push(ENV_PLAIN_RE.test(text) ? `${k}=${text}` : `${k}='${text}'`);
  }
  return `${lines.join('\n')}\n`;
}
