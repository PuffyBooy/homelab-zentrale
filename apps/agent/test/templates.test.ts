import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { gameTemplateSchema, type GameTemplate } from '@hz/shared';
import { GAMEDIG_TYPES } from '../src/actions/games.js';

/**
 * Every game template in templates/games/<id>/: template.json is valid against
 * gameTemplateSchema, compose.yml only uses known placeholders, publishes RCON on
 * 127.0.0.1 only and never contains a secret.
 */

const GAMES = fileURLToPath(new URL('../../../templates/games/', import.meta.url));
const SPEC_IDS = [
  'minecraft-java',
  'minecraft-bedrock',
  'valheim',
  'terraria',
  'cs2',
  'palworld',
  // M12
  'satisfactory',
  'factorio',
  'enshrouded',
  'project-zomboid',
  'ark-se',
  'rust',
  'v-rising',
] as const;

const ids = readdirSync(GAMES).filter((d) => statSync(path.join(GAMES, d)).isDirectory());

interface Loaded {
  id: string;
  raw: unknown;
  template: GameTemplate;
  compose: string;
  /** compose.yml without comment lines. */
  body: string;
}

function load(id: string): Loaded {
  const raw = JSON.parse(readFileSync(path.join(GAMES, id, 'template.json'), 'utf8')) as unknown;
  const compose = readFileSync(path.join(GAMES, id, 'compose.yml'), 'utf8');
  const body = compose
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  return { id, raw, template: gameTemplateSchema.parse(raw), compose, body };
}

const placeholders = (text: string) => [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? '');

/** Environment entries `KEY: value` (upper-case keys, any indentation). */
const envEntries = (body: string) =>
  [...body.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/gm)].map((m) => ({
    key: m[1] ?? '',
    value: (m[2] ?? '').trim(),
  }));

/** Port mappings: list items under `ports:` (quoted strings). */
function portLines(body: string): string[] {
  const out: string[] = [];
  let inPorts = false;
  for (const line of body.split('\n')) {
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts && /^\s+-\s/.test(line)) {
      out.push(line.replace(/^\s+-\s+/, '').replace(/^['"]|['"]$/g, ''));
      continue;
    }
    inPorts = false;
  }
  return out;
}

const SECRET_KEY = /PASS|PW$|_PW_|SECRET|TOKEN/;

describe('game templates', () => {
  it('has the templates from SPEC 6.2', () => {
    expect([...ids].sort()).toEqual([...SPEC_IDS].sort());
  });

  it('template.schema.json mirrors gameTemplateSchema', () => {
    const file = JSON.parse(readFileSync(path.join(GAMES, 'template.schema.json'), 'utf8')) as {
      title?: unknown;
      description?: unknown;
    };
    const { title, description, ...rest } = file;
    expect(typeof title).toBe('string');
    expect(typeof description).toBe('string');
    expect(rest).toEqual(
      z.toJSONSchema(gameTemplateSchema, { io: 'input', target: 'draft-2020-12' }),
    );
  });

  describe.each(ids)('%s', (id) => {
    const t = load(id);
    const tpl = t.template;
    const fieldKeys = new Set(tpl.fields.map((f) => f.key));
    const secretKeys = new Set(
      tpl.fields.filter((f) => f.type === 'text' && f.secret).map((f) => f.key),
    );

    it('template.json is valid and matches its folder', () => {
      expect(gameTemplateSchema.safeParse(t.raw).success).toBe(true);
      expect(tpl.id).toBe(id);
      expect((t.raw as { $schema?: string }).$schema).toBe('../template.schema.json');
      expect(tpl.dataDir).toBe('./data');
      for (const p of tpl.ports) expect(Number.isInteger(p.count)).toBe(true);
    });

    it('pins the image (no :latest) and uses the same image as template.json', () => {
      expect(tpl.image).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+$/);
      expect(tpl.image).not.toMatch(/:latest$/);
      const images = [...t.body.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]);
      expect(images).toEqual([tpl.image]);
    });

    it('query and rcon are consistent', () => {
      const portNames = tpl.ports.map((p) => p.name);
      if (tpl.query.method !== 'none' || tpl.query.port) {
        expect(portNames).toContain(tpl.query.port);
      }
      if (tpl.query.method === 'gamedig') {
        expect(tpl.query.type !== undefined && GAMEDIG_TYPES.has(tpl.query.type)).toBe(true);
      } else {
        expect(tpl.query.type).toBeUndefined();
      }
      if (tpl.rcon.supported) expect(tpl.rcon.port).toBeTypeOf('number');
      else expect(tpl.rcon.port).toBeUndefined();
      if (tpl.rcon.tpsCommand !== undefined) {
        expect(tpl.rcon.supported).toBe(true);
        expect(tpl.rcon.tpsCommand).toBe('tps');
      }
      expect(tpl.ram.min).toMatch(/^\d+G$/);
      expect(parseInt(tpl.ram.min, 10)).toBeLessThanOrEqual(parseInt(tpl.ram.recommended, 10));
    });

    it('every ${VAR} is a field key or a system value', () => {
      // TZ: system value from HZ_TIMEZONE (M12).
      const allowed = new Set<string>(['GAME_NAME', 'TZ']);
      for (const p of tpl.ports) {
        allowed.add(`PORT_${p.name.toUpperCase()}`);
        if (p.count > 1) allowed.add(`PORT_${p.name.toUpperCase()}_END`);
      }
      if (tpl.rcon.supported) {
        allowed.add('PORT_RCON');
        // Runtime placeholder (filled by docker compose from .env, see the RCON_PASSWORD test).
        allowed.add('RCON_PASSWORD');
      }
      for (const k of fieldKeys) if (!secretKeys.has(k)) allowed.add(k);
      const used = placeholders(t.body);
      expect(used.length).toBeGreaterThan(0);
      for (const v of used) expect(allowed, `unknown placeholder \${${v}}`).toContain(v);
      // Every non-secret field is used somewhere.
      for (const k of fieldKeys) {
        if (!secretKeys.has(k)) expect(used, `field ${k} unused`).toContain(k);
      }
      // No compose defaults/modifiers (${A:-b}) that the core would not understand.
      for (const v of used) expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
    });

    it('uses the time zone of the core, never a fixed one', () => {
      expect(t.body).toMatch(/^\s+TZ: \$\{TZ\}$/m);
      expect(t.body).not.toMatch(/Europe\//);
    });

    it('wake mode, mods and architectures fit the game (M12)', () => {
      const raw = t.raw as { wake?: unknown; arch?: unknown };
      expect(raw.wake, 'wake is explicit').toBeTypeOf('string');
      expect(raw.arch, 'arch is explicit').toBeDefined();
      if (id === 'minecraft-java') expect(tpl.wake).toBe('minecraft');
      else if (id === 'minecraft-bedrock') expect(tpl.wake).toBe('minecraft-bedrock');
      else expect(['raw', 'none']).toContain(tpl.wake);
      if (tpl.wake === 'minecraft') {
        expect(tpl.ports.some((p) => !p.local && p.protocol !== 'udp')).toBe(true);
      }
      if (tpl.wake === 'minecraft-bedrock') {
        expect(tpl.ports.some((p) => !p.local && p.protocol !== 'tcp')).toBe(true);
      }
      if (tpl.mods) {
        expect(id).toBe('minecraft-java');
        const type = tpl.fields.find((f) => f.key === tpl.mods?.typeField);
        expect(type?.type).toBe('select');
        if (type?.type === 'select') {
          for (const v of [...tpl.mods.plugins, ...tpl.mods.mods])
            expect(type.options).toContain(v);
        }
        expect(fieldKeys.has(tpl.mods.versionField)).toBe(true);
      }
      expect(new Set(tpl.arch).size).toBe(tpl.arch.length);
      for (const cmd of [tpl.rcon.sayCommand, tpl.rcon.whitelistAddCommand]) {
        if (cmd !== undefined) expect(tpl.rcon.supported).toBe(true);
      }
    });

    it('world download covers only world folders below ./data (M12)', () => {
      // Only templates whose world folders are known to hold no configs or logs.
      const expected: Record<string, string[]> = {
        'minecraft-java': ['world', 'world_nether', 'world_the_end'],
        'minecraft-bedrock': ['worlds'],
        valheim: ['worlds_local'],
        palworld: ['SaveGames'],
        factorio: ['saves'],
        'project-zomboid': ['Saves'],
        'ark-se': ['SavedArks'],
      };
      expect(tpl.worldPaths).toEqual(expected[id]);
      for (const p of tpl.worldPaths ?? []) {
        expect(p).not.toMatch(/config|log|properties|\.env|rcon|settings|server/i);
      }
      // A world download needs a ./data bind mount.
      if (tpl.worldPaths) expect(t.body).toMatch(/^\s+- \.\/data:/m);
    });

    it('names, labels, restart policy and memory limit', () => {
      expect(t.body).toMatch(/^\s+container_name: game-\$\{GAME_NAME\}$/m);
      expect(t.body).toMatch(/^\s+restart: unless-stopped$/m);
      expect(t.body).toMatch(/^\s+homelab\.game: \$\{GAME_NAME\}$/m);
      expect(t.body).toMatch(new RegExp(`^\\s+homelab\\.template: ${id}$`, 'm'));
      expect(t.body).toMatch(/^\s+mem_limit: \$\{MEMORY\}$/m);
      const mem = tpl.fields.find((f) => f.key === 'MEMORY');
      expect(mem?.type).toBe('select');
      if (mem?.type === 'select') {
        for (const o of mem.options) expect(o).toMatch(/^\d{1,3}G$/);
        expect(mem.options).toContain(tpl.ram.recommended);
        expect(mem.default).toBe(tpl.ram.recommended);
        expect(mem.options.every((o) => parseInt(o, 10) >= parseInt(tpl.ram.min, 10))).toBe(true);
      }
    });

    it('publishes every template port and RCON only on 127.0.0.1', () => {
      const lines = portLines(t.body);
      expect(lines.length).toBeGreaterThan(0);
      for (const p of tpl.ports) {
        const ph = `\${PORT_${p.name.toUpperCase()}}`;
        const mine = lines.filter((l) => l.includes(ph));
        expect(mine.length, `port ${p.name}`).toBeGreaterThan(0);
        const protos = p.protocol === 'tcp+udp' ? ['tcp', 'udp'] : [p.protocol];
        for (const proto of protos) {
          expect(mine.some((l) => l.endsWith(`/${proto}`))).toBe(true);
        }
        if (p.count > 1) {
          expect(mine.some((l) => l.includes(`\${PORT_${p.name.toUpperCase()}_END}`))).toBe(true);
        }
      }
      for (const l of lines) {
        expect(l).toMatch(/\/(tcp|udp)$/);
        if (l.includes('${PORT_RCON}')) {
          expect(l).toBe(`127.0.0.1:\${PORT_RCON}:${tpl.rcon.port}/tcp`);
        }
      }
      if (tpl.rcon.supported) {
        expect(lines).toContain(`127.0.0.1:\${PORT_RCON}:${tpl.rcon.port}/tcp`);
      } else {
        expect(t.body).not.toContain('PORT_RCON');
      }
    });

    it('never contains a secret inline; secrets come from env_file .env', () => {
      expect(t.body).toMatch(/^\s+env_file:\n\s+- \.env$/m);
      const env = envEntries(t.body);
      // RCON_PASSWORD itself reaches the container only through env_file.
      expect(env.find((e) => e.key === 'RCON_PASSWORD')).toBeUndefined();
      for (const e of env) {
        if (!SECRET_KEY.test(e.key)) continue;
        // The only allowed value: the runtime placeholder docker compose fills from .env.
        expect(e.value, `${e.key} must not be inline`).toBe('${RCON_PASSWORD}');
      }
      // ${RCON_PASSWORD} only ever stands alone as a whole value.
      for (const m of t.body.matchAll(/^.*\$\{RCON_PASSWORD\}.*$/gm)) {
        expect(m[0]).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{RCON_PASSWORD\}$/);
      }
      // Secret fields never appear as placeholders (they would be rendered into the file).
      for (const k of secretKeys) expect(placeholders(t.compose)).not.toContain(k);
      expect(t.body).not.toMatch(/changeme|\bsecret\b/i);
      for (const m of t.body.matchAll(/^.*pass(word)?\s*[:=].*$/gim)) {
        expect(m[0]).toMatch(/: \$\{RCON_PASSWORD\}$/);
      }
    });

    it('text fields with secret: true are optional or have a pattern', () => {
      for (const f of tpl.fields) {
        if (f.type === 'text' && f.secret) {
          expect(f.default).toBe('');
          expect(f.pattern).toBeDefined();
        }
        if (f.type === 'select') expect(f.options).toContain(f.default);
        if (f.type === 'text' && f.secret && f.pattern) {
          // The core refuses non-empty secrets under 8 chars (masking); the pattern says so too.
          const re = new RegExp(`^(?:${f.pattern})$`, 'u');
          expect(re.test('a'.repeat(7)), `${f.key} accepts 7 chars`).toBe(false);
          expect(re.test('A'.repeat(8)) || re.test('a'.repeat(8)), `${f.key} 8 chars`).toBe(true);
          if (f.label.includes('mind.')) expect(f.label).toContain('mind. 8 Zeichen');
        }
        if (f.type === 'number' && f.min !== undefined && f.max !== undefined) {
          expect(f.default).toBeGreaterThanOrEqual(f.min);
          expect(f.default).toBeLessThanOrEqual(f.max);
        }
      }
    });
  });
});
