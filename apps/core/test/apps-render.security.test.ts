import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  appInstallRequestSchema,
  appParamKeySchema,
  appTemplateMetaSchema,
  APP_RESERVED_KEYS,
  type AppTemplateMeta,
} from '@hz/shared';
import { checkCompose } from '../src/appstore/compose-check.js';
import {
  generatePassword,
  GENERATED_PASSWORD_LENGTH,
  PASSWORD_MASK,
  renderCompose,
  renderEnv,
  resolveValues,
  valueProblem,
} from '../src/appstore/render.js';
import {
  appTemplatesDir,
  loadBuiltinTemplates,
  metaProblems,
  REPO_APP_TEMPLATES_DIR,
  templateKeys,
} from '../src/appstore/templates.js';
import { APP_FIXTURES } from './apps-helpers.js';

const meta = (): AppTemplateMeta =>
  appTemplateMetaSchema.parse(
    JSON.parse(readFileSync(join(APP_FIXTURES, 'vaultwarden', 'template.json'), 'utf8')),
  );
const compose = (): string =>
  readFileSync(join(APP_FIXTURES, 'vaultwarden', 'compose.yml'), 'utf8');
const ctx = {
  appId: 'vault',
  appDir: '/opt/homelab/apps/vault',
  bindIp: '100.64.0.5',
  tz: 'Europe/Vienna',
};

describe('parameter values', () => {
  it.each(['a$b', '${X}', 'a\nb', 'a\rb', 'a\0b'])('the request schema refuses %j', (v) => {
    const r = appInstallRequestSchema.safeParse({
      templateId: 'vaultwarden',
      serverId: 'AAAAAAAAAAAAAAAAAAAAAA',
      appId: 'vault',
      name: 'x',
      params: { DOMAIN: v },
    });
    expect(r.success).toBe(false);
  });

  it.each([...APP_RESERVED_KEYS])('reserved key %s is no parameter key', (k) => {
    expect(appParamKeySchema.safeParse(k).success).toBe(false);
    const r = appInstallRequestSchema.safeParse({
      templateId: 'vaultwarden',
      serverId: 'AAAAAAAAAAAAAAAAAAAAAA',
      appId: 'vault',
      name: 'x',
      params: { [k]: '0.0.0.0' },
    });
    expect(r.success).toBe(false);
  });

  it.each(['a$b', 'a\nb', 'a\u0000b', "it's", 'back\\slash', 'bidi‮', 'x'.repeat(201)])(
    'resolveValues refuses %j (defense in depth)',
    (v) => {
      const r = resolveValues(meta(), { DOMAIN: v });
      expect(r.problems.length).toBeGreaterThan(0);
      expect(valueProblem(v)).not.toBeNull();
      // The problem never echoes the value.
      expect(r.problems.join(' ')).not.toContain(v);
    },
  );

  it('checks every type: unknown keys, pattern, ports, bool, password length', () => {
    const unknown = resolveValues(meta(), { NOPE_MARKER: 'x', OTHER: 'y' }).problems;
    expect(unknown).toContain('Unbekannter Parameter');
    expect(unknown.join()).not.toMatch(/NOPE_MARKER|OTHER/);
    expect(resolveValues(meta(), { DOMAIN: 'ftp://x' }).problems.join()).toContain('Format');
    expect(resolveValues(meta(), { WEB_PORT: 80 }).problems.join()).toContain('Port');
    expect(resolveValues(meta(), { WEB_PORT: '8080' }).problems.join()).toContain('Port');
    expect(resolveValues(meta(), { SIGNUPS_ALLOWED: 'yes' }).problems.join()).toContain(
      'Ja oder Nein',
    );
    expect(resolveValues(meta(), { ADMIN_TOKEN: 'short' }).problems.join()).toContain('mindestens');
    expect(resolveValues(meta(), { ADMIN_TOKEN: 'with space inside' }).problems.join()).toContain(
      'Leerzeichen',
    );
    const ok = resolveValues(meta(), { DOMAIN: 'https://vault.example.at', WEB_PORT: 8300 });
    expect(ok.problems).toEqual([]);
    expect(ok.resolved.values).toEqual({
      WEB_PORT: 8300,
      SIGNUPS_ALLOWED: false,
      DOMAIN: 'https://vault.example.at',
    });
    expect(ok.resolved.ports).toEqual([
      { key: 'WEB_PORT', port: 8300, protocol: 'tcp', label: 'Web-Port', web: true },
    ]);
  });

  it('generates 24 URL-safe characters per password, different each time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a.length).toBe(GENERATED_PASSWORD_LENGTH);
    expect(a).not.toBe(b);
    const r = resolveValues(meta(), {});
    expect(r.resolved.secrets.ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(r.resolved.values).not.toHaveProperty('ADMIN_TOKEN');
  });
});

describe('rendering', () => {
  it('.env has the core values and every parameter, single-quoted; mask hides passwords', () => {
    const r = resolveValues(meta(), {}).resolved;
    const env = renderEnv(meta(), ctx, r);
    const lines = env.trim().split('\n').slice(1);
    expect(lines).toEqual([
      "APP_ID='vault'",
      "APP_DIR='/opt/homelab/apps/vault'",
      "BIND='100.64.0.5'",
      "TZ='Europe/Vienna'",
      "PUID='1000'",
      "PGID='1000'",
      "WEB_PORT='8222'",
      `ADMIN_TOKEN='${r.secrets.ADMIN_TOKEN}'`,
      "SIGNUPS_ALLOWED='false'",
      "DOMAIN=''",
    ]);
    const masked = renderEnv(meta(), ctx, r, true);
    expect(masked).toContain(`ADMIN_TOKEN='${PASSWORD_MASK}'`);
    expect(masked).not.toContain(r.secrets.ADMIN_TOKEN);
  });

  it('refuses to write unsafe values even when they bypassed validation', () => {
    const r = resolveValues(meta(), {}).resolved;
    expect(() =>
      renderEnv(meta(), ctx, { ...r, values: { ...r.values, DOMAIN: "x'\nEVIL=1" } }),
    ).toThrow();
    expect(() => renderEnv(meta(), { ...ctx, appId: '../x' }, r)).toThrow();
  });

  it('adds homelab.app to every service (map, list and missing labels); output passes the check', () => {
    const text = `services:
  a:
    image: busybox:1.36
  b:
    image: busybox:1.36
    labels: { com.example: "1" }
  c:
    image: busybox:1.36
    labels: ["com.example=2"]
`;
    const out = renderCompose(text, 'vault');
    const tree = parse(out) as { services: Record<string, { labels: unknown }> };
    expect(tree.services.a?.labels).toEqual({ 'homelab.app': 'vault' });
    expect(tree.services.b?.labels).toEqual({ 'com.example': '1', 'homelab.app': 'vault' });
    expect(tree.services.c?.labels).toEqual(['com.example=2', 'homelab.app=vault']);
    const k = { keys: new Set<string>(APP_RESERVED_KEYS), portKeys: new Map() };
    expect(checkCompose(out, { ...k, appId: 'vault' })).toEqual([]);
    // The label with another app id, or in a template, is refused.
    expect(checkCompose(out, { ...k, appId: 'other' }).join()).toContain('homelab.app');
    expect(checkCompose(out, k).join()).toContain('homelab.app');
  });

  it('keeps placeholders in compose.yml (values only in .env)', () => {
    const out = renderCompose(compose(), 'vault');
    expect(out).toContain('${BIND}:${WEB_PORT}:80');
    expect(out).toContain('${ADMIN_TOKEN}');
    expect(checkCompose(out, { ...templateKeys(meta()), appId: 'vault' })).toEqual([]);
  });
});

describe('template metadata', () => {
  it.each([
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'DOCKER_HOST',
    'HZ_AGENT_TOKEN',
    'PATH',
    'HOME',
  ])('refuses parameter key %s (read by Compose or set in the agent environment)', (key) => {
    // The schema already refuses them (APP_HOST_ENV_*); the core check stays as a second line.
    const res = appTemplateMetaSchema.safeParse({
      ...meta(),
      params: [{ type: 'string', key, label: 'x', default: 'a' }],
    });
    expect(res.success).toBe(false);
  });

  it('accepts the fixture metadata', () => {
    expect(metaProblems(meta())).toEqual([]);
  });
});

describe('template loading', () => {
  const log = () => {
    const lines: { obj: object; msg: string }[] = [];
    return {
      lines,
      info: (obj: object, msg: string) => lines.push({ obj, msg }),
      warn: (obj: object, msg: string) => lines.push({ obj, msg }),
    };
  };

  it('loads the valid fixtures and skips the unsafe one with a log line', () => {
    const l = log();
    const t = loadBuiltinTemplates(APP_FIXTURES, l);
    expect([...t.keys()].sort()).toEqual(['armonly', 'bigram', 'vaultwarden']);
    expect(t.get('vaultwarden')?.source).toBe('builtin');
    const skipped = l.lines.find((x) => x.msg === 'app template skipped');
    expect(skipped?.obj).toMatchObject({ template: 'broken' });
    expect(JSON.stringify(skipped?.obj)).toContain('privileged');
  });

  it('skips bad folders: invalid JSON, id mismatch, invalid name, symlinked folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-apps-'));
    const good = readFileSync(join(APP_FIXTURES, 'vaultwarden', 'template.json'), 'utf8');
    mkdirSync(join(dir, 'badjson'));
    writeFileSync(join(dir, 'badjson', 'template.json'), '{');
    writeFileSync(join(dir, 'badjson', 'compose.yml'), compose());
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 'template.json'), good);
    writeFileSync(join(dir, 'other', 'compose.yml'), compose());
    mkdirSync(join(dir, 'Bad_Name'));
    symlinkSync(join(APP_FIXTURES, 'vaultwarden'), join(dir, 'vaultwarden'));
    // A real folder whose template.json is a symlink (O_NOFOLLOW).
    mkdirSync(join(dir, 'linked'));
    symlinkSync(
      join(APP_FIXTURES, 'vaultwarden', 'template.json'),
      join(dir, 'linked', 'template.json'),
    );
    writeFileSync(join(dir, 'linked', 'compose.yml'), compose());
    const l = log();
    expect(loadBuiltinTemplates(dir, l).size).toBe(0);
    expect(l.lines.filter((x) => x.msg.startsWith('app template skipped')).length).toBe(4);
    expect(l.lines.find((x) => JSON.stringify(x.obj).includes('"linked"'))?.obj).toMatchObject({
      reason: 'files missing or unreadable',
    });
    expect(loadBuiltinTemplates(join(dir, 'missing'), log()).size).toBe(0);
  });

  it('resolves the templates dir: override, HZ_APP_TEMPLATES_DIR, then the repo', () => {
    expect(appTemplatesDir('/x/y', {})).toBe('/x/y');
    expect(appTemplatesDir(undefined, { HZ_APP_TEMPLATES_DIR: '/srv/t' })).toBe('/srv/t');
    expect(appTemplatesDir(undefined, { HZ_APP_TEMPLATES_DIR: 'x'.repeat(5000) })).not.toContain(
      'xxxx',
    );
    expect(REPO_APP_TEMPLATES_DIR.endsWith('/templates/apps')).toBe(true);
  });
});
