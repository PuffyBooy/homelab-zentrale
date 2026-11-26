import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_RESERVED_KEYS, appTemplateMetaSchema, type AppTemplateMeta } from '@hz/shared';

/**
 * Every app template in templates/apps/<id>/ (M21): template.json is valid against
 * appTemplateMetaSchema, compose.yml only uses known placeholders, pins its images,
 * publishes every port on ${BIND}, keeps data in ./data/ and uses none of the
 * options in COMPOSE_FORBIDDEN. The core checks the rendered file again; this test
 * keeps the built-in templates clean.
 */

const APPS = fileURLToPath(new URL('../../../templates/apps/', import.meta.url));
const REQUIRED_IDS = [
  'jellyfin',
  'nextcloud',
  'vaultwarden',
  'forgejo',
  'paperless-ngx',
  'syncthing',
  'audiobookshelf',
  'navidrome',
  'freshrss',
  'uptime-kuma',
  'mealie',
] as const;

const ids = readdirSync(APPS).filter((d) => statSync(path.join(APPS, d)).isDirectory());

interface Service {
  name: string;
  /** Lines of the service block (indent 4 and deeper), comments removed. */
  lines: string[];
}

interface Loaded {
  raw: unknown;
  meta: AppTemplateMeta;
  compose: string;
  /** compose.yml without comment lines. */
  body: string;
  topLevel: string[];
  services: Service[];
}

function load(id: string): Loaded {
  const raw = JSON.parse(readFileSync(path.join(APPS, id, 'template.json'), 'utf8')) as unknown;
  const compose = readFileSync(path.join(APPS, id, 'compose.yml'), 'utf8');
  const lines = compose.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
  const body = lines.join('\n');
  const topLevel = lines.filter((l) => /^\S/.test(l)).map((l) => l.replace(/:.*$/, ''));
  const services: Service[] = [];
  let inServices = false;
  for (const l of lines) {
    if (/^\S/.test(l)) {
      inServices = l === 'services:';
      continue;
    }
    if (!inServices) continue;
    const m = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(l);
    if (m) services.push({ name: m[1] as string, lines: [] });
    else services.at(-1)?.lines.push(l);
  }
  return {
    raw,
    meta: appTemplateMetaSchema.parse(raw),
    compose,
    body,
    topLevel,
    services,
  };
}

/** List items under `key:` in a service block (indent 4 key, indent 6 items). */
function listOf(s: Service, key: string): string[] {
  const out: string[] = [];
  let inKey = false;
  for (const l of s.lines) {
    if (/^ {4}\S/.test(l)) {
      inKey = l === `    ${key}:`;
      continue;
    }
    if (inKey && /^ {6}- /.test(l)) out.push(l.replace(/^ {6}- /, '').replace(/^'(.*)'$/, '$1'));
  }
  return out;
}

const keysOf = (s: Service) =>
  s.lines.filter((l) => /^ {4}[a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));

const placeholders = (text: string) => [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? '');

const SECRET_KEY = /PASS|SECRET|TOKEN|_KEY$/;
const FORBIDDEN_SERVICE_KEYS = [
  'privileged',
  'cap_add',
  'devices',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'security_opt',
  'build',
  'env_file',
  'volumes_from',
  'cgroup_parent',
  'device_cgroup_rules',
  'sysctls',
];

describe('app templates', () => {
  it('has at least the templates from ROADMAP M21', () => {
    for (const id of REQUIRED_IDS) expect(ids).toContain(id);
  });

  describe.each(ids)('%s', (id) => {
    const t = load(id);
    const meta = t.meta;
    const paramKeys = new Set(meta.params.map((p) => p.key));
    const portParams = new Map(
      meta.params.filter((p) => p.type === 'port').map((p) => [p.key, p] as const),
    );

    it('template.json is valid, matches its folder and is German', () => {
      expect(appTemplateMetaSchema.safeParse(t.raw).success).toBe(true);
      expect(meta.id).toBe(id);
      expect(meta.arch.length).toBeGreaterThan(0);
      expect(new Set(meta.arch).size).toBe(meta.arch.length);
      expect(meta.minRamMb).toBeGreaterThanOrEqual(64);
      expect(meta.hints.length).toBeGreaterThan(0);
      expect(meta.params.filter((p) => p.type === 'port' && p.web)).toHaveLength(1);
      // German texts: no English UI words where a German one is expected.
      expect(meta.description).not.toMatch(/\b(the|and|with|server for)\b/i);
    });

    it('secrets are generated password params', () => {
      for (const p of meta.params) {
        if (SECRET_KEY.test(p.key)) {
          expect(p.type, `${p.key} must be a password`).toBe('password');
        }
        if (p.type === 'password') expect(p.generate).toBe(true);
      }
    });

    it('pins every image (no :latest, no digest-less floating tag) and the version matches', () => {
      const images = [...t.body.matchAll(/^ {4}image:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
      expect(images.length).toBe(t.services.length);
      for (const img of images) {
        expect(img).toMatch(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)*:[A-Za-z0-9._-]+$/);
        const tag = img.slice(img.lastIndexOf(':') + 1);
        expect(tag).not.toMatch(/latest|stable|edge|nightly|dev|main|master|beta|rc/i);
        expect(tag, `${img} needs a version`).toMatch(/\d+\.\d+/);
        expect(img).not.toContain('$');
      }
      expect(
        images.some((img) => img.slice(img.lastIndexOf(':') + 1).includes(meta.version)),
        'version belongs to one image tag',
      ).toBe(true);
      expect(t.compose).not.toMatch(/:latest\b/);
    });

    it('every ${KEY} is a param or a reserved key, every param is used', () => {
      const allowed = new Set<string>([...APP_RESERVED_KEYS, ...paramKeys]);
      const used = placeholders(t.body);
      for (const v of used) {
        // No compose defaults/modifiers (${A:-b}) the core would not understand.
        expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(allowed, `unknown placeholder \${${v}}`).toContain(v);
      }
      for (const k of paramKeys) expect(used, `param ${k} unused`).toContain(k);
      // No bare $VAR or $$ escapes: every value comes from ${KEY}.
      expect(t.body.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, '')).not.toContain('$');
    });

    it('uses the time zone of the core', () => {
      expect(t.body).toMatch(/^\s+TZ: \$\{TZ\}$/m);
      expect(t.body).not.toMatch(/Europe\//);
    });

    it('only services at the top level, at most 10, no named volumes or networks', () => {
      expect(t.topLevel).toEqual(['services']);
      expect(t.services.length).toBeGreaterThan(0);
      expect(t.services.length).toBeLessThanOrEqual(10);
      // Block style only (the checks above parse it line by line).
      expect(t.body).not.toMatch(/:\s*[[{]/);
    });

    it('no forbidden compose options', () => {
      for (const s of t.services) {
        const keys = keysOf(s);
        for (const k of FORBIDDEN_SERVICE_KEYS) expect(keys, `${s.name}: ${k}`).not.toContain(k);
        expect(keys).toContain('restart');
        expect(s.lines).toContain('    restart: unless-stopped');
        if (keys.includes('container_name')) {
          const v = s.lines.find((l) => l.startsWith('    container_name:')) ?? '';
          expect(v).toMatch(/^ {4}container_name: \$\{APP_ID\}(-[a-z0-9-]+)?$/);
        }
      }
      expect(t.body).not.toMatch(/docker\.sock|hz\.role|privileged|\/var\/run|\/proc|\/sys\b/);
    });

    it('every published port is ${BIND}:${PORT_PARAM}:<container port>', () => {
      const published = new Set<string>();
      for (const s of t.services) {
        for (const p of listOf(s, 'ports')) {
          const m = /^\$\{BIND\}:\$\{([A-Z][A-Z0-9_]*)\}:(\d{1,5})(?:\/(tcp|udp))?$/.exec(p);
          expect(m, `${s.name}: port ${p}`).not.toBeNull();
          if (!m) continue;
          const param = portParams.get(m[1] as string);
          expect(param, `${m[1]} is a port param`).toBeDefined();
          expect(param?.protocol ?? 'tcp').toBe(m[3] ?? 'tcp');
          const containerPort = Number(m[2]);
          expect(containerPort).toBeGreaterThan(0);
          expect(containerPort).toBeLessThanOrEqual(65535);
          published.add(m[1] as string);
        }
        // The ports list is the only place a host port may appear.
        expect(s.lines.some((l) => /^\s+expose:/.test(l))).toBe(false);
      }
      expect([...published].sort()).toEqual([...portParams.keys()].sort());
    });

    it('data only as bind mounts below ./data/', () => {
      for (const s of t.services) {
        for (const v of listOf(s, 'volumes')) {
          const m =
            /^\.\/data\/([a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9._-]+)*:(\/[^:\s]*)(?::(ro|rw))?$/.exec(
              v,
            );
          expect(m, `${s.name}: volume ${v}`).not.toBeNull();
          expect(v).not.toContain('..');
        }
      }
    });
  });
});
