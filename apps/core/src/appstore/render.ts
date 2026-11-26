import { randomBytes } from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { appIdSchema, type AppParam, type AppTemplateMeta } from '@hz/shared';

/**
 * Rendering of a stack template: parameter values are checked per type and go
 * into .env (single-quoted, so Compose never interpolates or strips them);
 * compose.yml keeps its `${KEY}` placeholders and only gets the label
 * `homelab.app=<appId>` on every service.
 */

export type ParamValue = string | number | boolean;

/** Length of a generated password (URL-safe characters). */
export const GENERATED_PASSWORD_LENGTH = 24;
export const PUID = 1000;
export const PGID = 1000;
export const PASSWORD_MASK = '••••••';

/** 24 random URL-safe characters (crypto.randomBytes, base64url). */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url').slice(0, GENERATED_PASSWORD_LENGTH);
}

/**
 * Why a text value cannot be written (German, without the value), or null.
 * .env values are single-quoted: no `'`, no backslash (Compose would read `\'`
 * as an escaped quote), no `$`, no control or format characters (newlines,
 * NUL, bidi marks).
 */
export function valueProblem(v: string): string | null {
  if (v.length > 200) return 'ist zu lang';
  if (/[\p{Cc}\p{Cf}]/u.test(v)) return 'enthält Steuerzeichen oder Zeilenumbrüche';
  if (v.includes('$')) return 'darf kein $ enthalten';
  if (v.includes("'") || v.includes('\\')) return "darf kein ' und keinen Backslash enthalten";
  return null;
}

export interface ResolvedPort {
  key: string;
  port: number;
  protocol: 'tcp' | 'udp';
  label: string;
  web: boolean;
}

export interface ResolvedValues {
  /** Non-secret values (stored in params_json, shown in the API). */
  values: Record<string, ParamValue>;
  /** Password values (stored encrypted, only in .env and GET .../secrets). */
  secrets: Record<string, string>;
  ports: ResolvedPort[];
}

export interface ResolveResult {
  resolved: ResolvedValues;
  problems: string[];
}

function resolveOne(
  p: AppParam,
  has: boolean,
  input: ParamValue | undefined,
  prev: ParamValue | undefined,
  generate: () => string,
): { value?: ParamValue; problem?: string } {
  const label = `„${p.label}“`;
  switch (p.type) {
    case 'string': {
      const v = has ? input : (prev ?? p.default ?? '');
      if (typeof v !== 'string') return { problem: `${label}: muss Text sein` };
      const prob = valueProblem(v);
      if (prob) return { problem: `${label} ${prob}` };
      if (v === '' && p.required) return { problem: `${label}: Pflichtfeld` };
      if (v !== '' && p.pattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(`^(?:${p.pattern})$`, 'u');
        } catch {
          return { problem: `${label}: ungültiges Muster in der Vorlage` };
        }
        if (!re.test(v)) return { problem: `${label}: Format passt nicht` };
      }
      return { value: v };
    }
    case 'password': {
      let v = has ? input : prev;
      if (v === undefined || v === '') {
        if (!p.generate) return { problem: `${label}: Pflichtfeld` };
        v = generate();
      }
      if (typeof v !== 'string') return { problem: `${label}: muss Text sein` };
      const prob = valueProblem(v);
      if (prob) return { problem: `${label} ${prob}` };
      if (/\s/u.test(v)) return { problem: `${label} darf keine Leerzeichen enthalten` };
      if ([...v].length < p.minLength)
        return { problem: `${label}: mindestens ${p.minLength} Zeichen` };
      return { value: v };
    }
    case 'port': {
      const v = has ? input : (prev ?? p.default);
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 || v > 65535) {
        return { problem: `${label}: Port von 1024 bis 65535` };
      }
      return { value: v };
    }
    case 'number': {
      const v = has ? input : (prev ?? p.default);
      if (typeof v !== 'number' || !Number.isInteger(v))
        return { problem: `${label}: muss eine Zahl sein` };
      if (v < p.min || v > p.max) return { problem: `${label}: von ${p.min} bis ${p.max}` };
      return { value: v };
    }
    case 'select': {
      const v = has ? input : (prev ?? p.default);
      if (typeof v !== 'string' || !p.options.some((o) => o.value === v)) {
        return { problem: `${label}: keine gültige Auswahl` };
      }
      return { value: v };
    }
    case 'bool': {
      const v = has ? input : (prev ?? p.default);
      if (typeof v !== 'boolean') return { problem: `${label}: muss Ja oder Nein sein` };
      return { value: v };
    }
  }
}

/**
 * Checks `input` against the template parameters. Missing keys take `previous`
 * (update) or the default; empty passwords with `generate` get a new one.
 */
export function resolveValues(
  meta: AppTemplateMeta,
  input: Readonly<Record<string, ParamValue>>,
  previous: { values: Record<string, ParamValue>; secrets: Record<string, string> } = {
    values: {},
    secrets: {},
  },
  generate: () => string = generatePassword,
): ResolveResult {
  const problems: string[] = [];
  const known = new Set(meta.params.map((p) => p.key));
  for (const k of Object.keys(input)) {
    if (!known.has(k)) {
      problems.push('Unbekannter Parameter');
      break;
    }
  }
  const resolved: ResolvedValues = { values: {}, secrets: {}, ports: [] };
  for (const p of meta.params) {
    const has = Object.hasOwn(input, p.key);
    const prev = p.type === 'password' ? previous.secrets[p.key] : previous.values[p.key];
    const r = resolveOne(p, has, has ? input[p.key] : undefined, prev, generate);
    if (r.problem !== undefined) {
      problems.push(r.problem);
      continue;
    }
    if (r.value === undefined) continue;
    if (p.type === 'password') resolved.secrets[p.key] = String(r.value);
    else resolved.values[p.key] = r.value;
    if (p.type === 'port' && typeof r.value === 'number') {
      resolved.ports.push({
        key: p.key,
        port: r.value,
        protocol: p.protocol,
        label: p.label,
        web: p.web,
      });
    }
  }
  const seen = new Set<string>();
  for (const p of resolved.ports) {
    const k = `${p.protocol}/${p.port}`;
    if (seen.has(k)) problems.push(`Port ${p.port}/${p.protocol} ist doppelt vergeben`);
    seen.add(k);
  }
  return { resolved, problems };
}

export interface EnvContext {
  appId: string;
  appDir: string;
  bindIp: string;
  tz: string;
}

/** Thrown when a value cannot be written (never carries the value). */
export class RenderError extends Error {
  constructor(readonly key: string) {
    super(`${key}: value cannot be written`);
    this.name = 'RenderError';
  }
}

/**
 * .env of the app folder (mode 0600, written by the agent): core values first,
 * then every parameter, `KEY='value'` per line. `mask` replaces passwords
 * (preview).
 */
export function renderEnv(
  meta: AppTemplateMeta,
  ctx: EnvContext,
  r: ResolvedValues,
  mask = false,
): string {
  const lines = ['# Written by homelab-zentrale. Contains secrets; do not edit or share.'];
  const add = (k: string, v: ParamValue): void => {
    const text = String(v);
    // Defense in depth: values were validated, but never write anything unsafe.
    if (valueProblem(text) !== null) throw new RenderError(k);
    lines.push(`${k}='${text}'`);
  };
  if (!appIdSchema.safeParse(ctx.appId).success) throw new RenderError('APP_ID');
  add('APP_ID', ctx.appId);
  add('APP_DIR', ctx.appDir);
  add('BIND', ctx.bindIp);
  add('TZ', ctx.tz);
  add('PUID', PUID);
  add('PGID', PGID);
  for (const p of meta.params) {
    if (p.type === 'password') {
      const v = r.secrets[p.key];
      if (v !== undefined) add(p.key, mask ? PASSWORD_MASK : v);
    } else {
      const v = r.values[p.key];
      if (v !== undefined) add(p.key, v);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * compose.yml as written to the server: the template with `homelab.app=<appId>`
 * on every service. Throws RenderError when the file has no services map (the
 * safety check refuses such files before).
 */
export function renderCompose(compose: string, appId: string): string {
  if (!appIdSchema.safeParse(appId).success) throw new RenderError('APP_ID');
  const doc = parseDocument(compose, { merge: false, uniqueKeys: true, version: '1.2' });
  if (doc.errors.length > 0) throw new RenderError('compose');
  const services = doc.get('services', true);
  if (!isMap(services)) throw new RenderError('services');
  for (const item of services.items) {
    const svc = item.value;
    if (!isMap(svc)) throw new RenderError('services');
    const labels = svc.get('labels', true);
    if (labels === undefined || labels === null || (isScalar(labels) && labels.value === null)) {
      svc.set('labels', doc.createNode({ 'homelab.app': appId }));
    } else if (isMap(labels)) {
      labels.set('homelab.app', appId);
    } else if (isSeq(labels)) {
      labels.add(doc.createNode(`homelab.app=${appId}`));
    } else {
      throw new RenderError('labels');
    }
  }
  return doc.toString({ lineWidth: 0 });
}
