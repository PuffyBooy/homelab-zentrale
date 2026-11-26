import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameTemplateSchema } from '@hz/shared';
import { collectUsed, firstFree, ramCheck, suggestPorts } from '../src/games/ports.js';
import { parseBackupResult, translateProgress } from '../src/games/agent-text.js';
import { renderCompose, renderEnv, validateValues, ValueError } from '../src/games/render.js';
import { isSafeText } from '../src/games/safe-text.js';
import { gameDirOf, scrub, validExternalAddress } from '../src/games/service.js';
import { gameState } from '../src/games/status.js';
import {
  loadTemplates,
  parseTemplate,
  TemplateError,
  tokenizeCompose,
} from '../src/games/templates.js';
import { fakeSecret, FIXTURE_TEMPLATES, REPO_TEMPLATES } from './games-helpers.js';
import { emptyDir } from './helpers.js';

const MC_JSON = readFileSync(join(FIXTURE_TEMPLATES, 'minecraft-java', 'template.json'), 'utf8');
const MC_COMPOSE = readFileSync(join(FIXTURE_TEMPLATES, 'minecraft-java', 'compose.yml'), 'utf8');

function logger() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    info: (obj: object, msg: string) =>
      lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    warn: (obj: object, msg: string) =>
      lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
  };
}

function withCompose(compose: string, json = MC_JSON) {
  return () => parseTemplate('minecraft-java', json, compose);
}

function withJson(patch: (t: Record<string, unknown>) => void) {
  const t = JSON.parse(MC_JSON) as Record<string, unknown>;
  patch(t);
  return () => parseTemplate('minecraft-java', JSON.stringify(t), MC_COMPOSE);
}

describe('template loader', () => {
  it('loads the valid fixtures and skips invalid ones with a log line', () => {
    // Invalid JSON is created here (a broken file in the repo would fail prettier).
    const dir = emptyDir();
    cpSync(FIXTURE_TEMPLATES, dir, { recursive: true });
    mkdirSync(join(dir, 'broken-json'));
    writeFileSync(join(dir, 'broken-json', 'template.json'), '{ "id": "broken-json",');
    writeFileSync(join(dir, 'broken-json', 'compose.yml'), 'services: {}\n');
    const log = logger();
    const map = loadTemplates(dir, log);
    expect([...map.keys()]).toEqual(['minecraft-java', 'valheim']);
    const skipped = log.lines.filter((l) => l.level === 'warn');
    expect(skipped.map((l) => l.obj.template).sort()).toEqual([
      'Bad_Name',
      'broken-json',
      'public-rcon',
      'unknown-var',
      'wrong-id',
    ]);
    expect(skipped.find((l) => l.obj.template === 'unknown-var')?.obj.reason).toMatch(
      /unknown \$\{HOSTNAME\}/,
    );
    expect(skipped.find((l) => l.obj.template === 'public-rcon')?.obj.reason).toMatch(
      /127\.0\.0\.1/,
    );
  });

  it('a missing directory yields no templates', () => {
    const log = logger();
    expect(loadTemplates('/nonexistent/hz-templates', log).size).toBe(0);
    expect(log.lines[0]?.level).toBe('warn');
  });

  it('every template shipped in the repo is valid', () => {
    const log = logger();
    const map = loadTemplates(REPO_TEMPLATES, log);
    expect(log.lines.filter((l) => l.level === 'warn')).toEqual([]);
    expect(map.has('minecraft-java')).toBe(true);
    for (const l of map.values()) expect(gameTemplateSchema.parse(l.template)).toBeTruthy();
  });
});

describe('template rules', () => {
  it.each([
    ['unknown placeholder', 'x: ${NOPE}\n'],
    ['default syntax', 'x: ${TYPE:-PAPER}\n'],
    ['bare dollar var', 'x: $TYPE\n'],
    ['lower case', 'x: ${type}\n'],
    ['unclosed', 'x: ${TYPE\n'],
    ['nested', 'x: ${${TYPE}}\n'],
    ['multi-line quote', 'x: "a\n  b"\n'],
    ['carriage return', 'x: a\ry\n'],
  ])('rejects compose with %s', (_name, extra) => {
    expect(withCompose(MC_COMPOSE + extra)).toThrow(TemplateError);
  });

  it('allows $$ and comments with placeholders', () => {
    const l = withCompose(`${MC_COMPOSE}    command: "echo $$HOME"\n# ${'${ANYTHING}'}\n`)();
    expect(l.template.id).toBe('minecraft-java');
  });

  it('RCON only on 127.0.0.1, ports must be published', () => {
    expect(
      withCompose(MC_COMPOSE.replace('127.0.0.1:${PORT_RCON}', '0.0.0.0:${PORT_RCON}')),
    ).toThrow(/127\.0\.0\.1/);
    expect(
      withCompose(MC_COMPOSE.replace("'${PORT_GAME}:25565/tcp'", "'25565:25565/tcp'")),
    ).toThrow(/not published/);
  });

  it.each([
    [
      'field collides with GAME_NAME',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({ key: 'GAME_NAME', label: 'x', type: 'text', default: 'a' });
      },
    ],
    [
      'field collides with RCON_PASSWORD',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({
          key: 'RCON_PASSWORD',
          label: 'x',
          type: 'text',
          default: 'a',
        });
      },
    ],
    [
      'field uses PORT_ prefix',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({ key: 'PORT_X', label: 'x', type: 'number', default: 1 });
      },
    ],
    [
      'duplicate field',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({ key: 'TYPE', label: 'x', type: 'text', default: 'a' });
      },
    ],
    [
      'unsafe default',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({ key: 'X', label: 'x', type: 'text', default: 'a"b' });
      },
    ],
    [
      'unsafe option',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({
          key: 'X',
          label: 'x',
          type: 'select',
          options: ['a\nb'],
          default: 'a\nb',
        });
      },
    ],
    [
      'default not an option',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({
          key: 'X',
          label: 'x',
          type: 'select',
          options: ['a'],
          default: 'b',
        });
      },
    ],
    [
      'invalid pattern',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({
          key: 'X',
          label: 'x',
          type: 'text',
          default: 'a',
          pattern: '(',
        });
      },
    ],
    [
      'default out of range',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({ key: 'X', label: 'x', type: 'number', default: 5, max: 2 });
      },
    ],
    [
      'secret with default',
      (t: Record<string, unknown>) => {
        (t.fields as unknown[]).push({
          key: 'X',
          label: 'x',
          type: 'text',
          default: 'pw',
          secret: true,
        });
      },
    ],
    [
      'unknown key in template.json',
      (t: Record<string, unknown>) => {
        t.command = 'rm -rf /';
      },
    ],
    [
      'port named rcon',
      (t: Record<string, unknown>) => {
        t.ports = [{ name: 'rcon', container: 1, protocol: 'tcp', default: 25575 }];
      },
    ],
    [
      'query port unknown',
      (t: Record<string, unknown>) => {
        t.query = { method: 'minecraft', port: 'nope' };
      },
    ],
    [
      'rcon without port',
      (t: Record<string, unknown>) => {
        t.rcon = { supported: true };
      },
    ],
    [
      'tps command not allowed',
      (t: Record<string, unknown>) => {
        t.rcon = { supported: true, port: 25575, tpsCommand: 'stop' };
      },
    ],
    [
      'dataDir traversal',
      (t: Record<string, unknown>) => {
        t.dataDir = '../../etc';
      },
    ],
  ])('rejects template with %s', (_name, patch) => {
    expect(withJson(patch)).toThrow();
  });

  it('local ports must be published on 127.0.0.1 only', () => {
    const json = JSON.parse(MC_JSON) as { ports: unknown[] };
    json.ports.push({ name: 'api', container: 8212, protocol: 'tcp', default: 8212, local: true });
    const ok = `${MC_COMPOSE}      - '127.0.0.1:${'${PORT_API}'}:8212/tcp'\n`;
    expect(parseTemplate('minecraft-java', JSON.stringify(json), ok).template.ports[1]?.local).toBe(
      true,
    );
    const open = `${MC_COMPOSE}      - '${'${PORT_API}'}:8212/tcp'\n`;
    expect(() => parseTemplate('minecraft-java', JSON.stringify(json), open)).toThrow(
      /127\.0\.0\.1/,
    );
    const range = JSON.parse(MC_JSON) as { ports: unknown[] };
    range.ports.push({
      name: 'api',
      container: 8212,
      protocol: 'tcp',
      default: 8212,
      count: 2,
      local: true,
    });
    const r = `${MC_COMPOSE}      - '127.0.0.1:${'${PORT_API}'}-${'${PORT_API_END}'}:8212-8213/tcp'\n`;
    expect(parseTemplate('minecraft-java', JSON.stringify(range), r).template.id).toBe(
      'minecraft-java',
    );
  });

  it('rejects a folder whose name is not the id', () => {
    expect(() => parseTemplate('other', MC_JSON, MC_COMPOSE)).toThrow(/folder name/);
  });

  it('records the YAML context of each placeholder', () => {
    const tokens = tokenizeCompose(
      'a: ${A}\n- ${B}\nc: "x-${C}"\nd: \'${D}\'\ne: pre-${E}\n"k": ${F} # c\n${G}: v\n',
    ).filter((t) => t.kind === 'var');
    expect(tokens.map((t) => (t.kind === 'var' ? `${t.name}:${t.context}` : ''))).toEqual([
      'A:full',
      'B:full',
      'C:double',
      'D:single',
      'E:embedded',
      'F:full',
      'G:embedded',
    ]);
  });
});

describe('rendering', () => {
  const l = parseTemplate('minecraft-java', MC_JSON, MC_COMPOSE);
  const input = (values: Record<string, unknown> = {}) => ({
    name: 'survival',
    ports: [{ name: 'game', port: 25570, protocol: 'tcp' as const, count: 1 }],
    rconPort: 25580,
    values: validateValues(l.template, values),
    rconPassword: 'A'.repeat(32),
  });

  it('renders numbers plain, strings and booleans quoted, secrets never', () => {
    const out = renderCompose(l, input({ MAX_PLAYERS: 7, MOTD: 'Hallo Welt' }));
    expect(out).toContain('MAX_PLAYERS: 7\n');
    expect(out).toContain('MOTD: "Hallo Welt"\n');
    expect(out).toContain('ONLINE_MODE: "true"\n');
    expect(out).toContain('LEVEL: world-world\n');
    expect(out).toContain("- '25570:25565/tcp'");
    expect(out).toContain("- '127.0.0.1:25580:25575/tcp'");
    expect(out).not.toContain('AAAAAAAA');
    expect(out).not.toMatch(/\$\{(?!RCON_PASSWORD)/);
    expect(out.startsWith('#')).toBe(false);
  });

  it('.env holds only RCON_PASSWORD, PORT_RCON and secret fields, unquoted', () => {
    const env = renderEnv(l, input({ MOTD: 'Hallo # Welt' }));
    const lines = env.split('\n').filter((x) => x !== '' && !x.startsWith('#'));
    expect(lines).toEqual([`RCON_PASSWORD=${'A'.repeat(32)}`, 'PORT_RCON=25580']);

    const v = parseTemplate(
      'valheim',
      readFileSync(join(FIXTURE_TEMPLATES, 'valheim', 'template.json'), 'utf8'),
      readFileSync(join(FIXTURE_TEMPLATES, 'valheim', 'compose.yml'), 'utf8'),
    );
    const pass = fakeSecret();
    const vin = {
      name: 'valheim',
      ports: [{ name: 'game', port: 2456, protocol: 'udp' as const, count: 3 }],
      rconPort: null,
      values: validateValues(v.template, { SERVER_PASS: pass }),
      rconPassword: null,
    };
    expect(
      renderEnv(v, vin)
        .split('\n')
        .filter((x) => x !== '' && !x.startsWith('#')),
    ).toEqual([`SERVER_PASS=${pass}`]);
    const c = renderCompose(v, vin);
    expect(c).toContain('SERVER_PASS: ${SERVER_PASS}');
    expect(c).toContain("- '2456-2458:2456-2458/udp'");
    // Secret values with whitespace or # are refused (the line is unquoted).
    for (const bad of ['ab cd', 'ab#cd', ' abcde']) {
      expect(() => validateValues(v.template, { SERVER_PASS: bad })).toThrow(ValueError);
    }
  });

  it('refuses unsafe values even if validation were bypassed', () => {
    const bad = input();
    bad.values.values.MOTD = 'a\nports: []';
    expect(() => renderCompose(l, bad)).toThrow(ValueError);
    const badSecret = input();
    badSecret.values.secrets.EXTRA = 'a\nRCON_PASSWORD=x';
    expect(() => renderEnv(l, badSecret)).toThrow(ValueError);
    const embedded = input();
    embedded.values.values.LEVEL = 'my world';
    expect(() => renderCompose(l, embedded)).toThrow(ValueError);
  });

  it('validateValues keeps previous values and rejects unknown keys', () => {
    const prev = validateValues(l.template, { MAX_PLAYERS: 3 });
    expect(validateValues(l.template, { TYPE: 'FABRIC' }, prev).values).toMatchObject({
      MAX_PLAYERS: 3,
      TYPE: 'FABRIC',
    });
    expect(() => validateValues(l.template, { constructor: 'x' })).toThrow(ValueError);
  });

  it('safe text', () => {
    expect(isSafeText('Grüß Gott, Österreich! (1.21)')).toBe(true);
    for (const v of ['a\nb', 'a$b', 'a"b', "a'b", 'a\\b', 'a`b', '​', '﻿', 'x'.repeat(201)]) {
      expect(isSafeText(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe('ports and RAM', () => {
  const l = parseTemplate('minecraft-java', MC_JSON, MC_COMPOSE);

  it('skips listening ports, container ports and other games (ranges, protocols)', () => {
    const used = collectUsed({
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 25565 },
        { proto: 'udp', address: '0.0.0.0', port: 25566 },
      ],
      containerPorts: [{ privatePort: 1, publicPort: 25566, proto: 'tcp' }],
      games: [
        { ports: [{ name: 'game', port: 25567, protocol: 'tcp+udp', count: 2 }], rconPort: 25575 },
      ],
    });
    expect(suggestPorts(l.template, used)).toEqual({ game: 25569 });
    expect(firstFree(used, 2456, 'udp', 3)).toBe(2456);
    expect(firstFree(used, 25566, 'udp', 1)).toBe(25567 + 2);
    expect(firstFree(used, 65535, 'tcp', 2)).toBe(1024);
  });

  it('warns in German when too little RAM is free', () => {
    const GB = 1024 ** 3;
    expect(ramCheck({ usedBytes: 14 * GB, totalBytes: 16 * GB }, '6G')).toEqual({
      freeRamBytes: 2 * GB,
      ramWarning: 'Zu wenig RAM frei (2 GB frei, 6 GB empfohlen)',
    });
    expect(ramCheck({ usedBytes: 2 * GB, totalBytes: 16 * GB }, '6G').ramWarning).toBeNull();
    expect(ramCheck(null, '6G')).toEqual({ freeRamBytes: null, ramWarning: null });
  });
});

describe('helpers', () => {
  it('game dirs are only ever /opt/homelab/games/<name>', () => {
    expect(gameDirOf('survival')).toBe('/opt/homelab/games/survival');
    for (const n of ['..', '../x', 'a/b', '', 'A', '.x']) expect(() => gameDirOf(n)).toThrow();
  });

  it('external address: host name or IPv4 only', () => {
    for (const a of ['', 'mc.hoebe.at', '203.0.113.5', 'heimserver']) {
      expect(validExternalAddress(a), a).toBe(true);
    }
    for (const a of ['http://x', 'x:25565', 'a b', '-x.at', 'x..at', 'a/b', '[::1]']) {
      expect(validExternalAddress(a), a).toBe(false);
    }
  });

  it('scrub replaces secrets in agent output', () => {
    const secret = fakeSecret();
    expect(scrub(`pw=${secret} and ${secret}`, [secret])).toBe('pw=*** and ***');
  });

  it('status texts', () => {
    const base = {
      phase: 'running' as const,
      phaseText: null,
      busyText: null,
      connected: true,
      container: { state: 'running' as const, exitCode: null, startedAt: 0 },
      status: null,
      statusAt: null,
      noQuery: false,
      now: 1000,
    };
    expect(gameState(base).statusText).toBe('Startet');
    expect(gameState({ ...base, now: 11 * 60_000 }).statusText).toBe('Antwortet nicht');
    expect(
      gameState({ ...base, container: { state: 'exited', exitCode: 137, startedAt: 0 } }),
    ).toMatchObject({
      status: 'crit',
      statusText: 'Container abgestürzt (Exit 137)',
    });
    expect(gameState({ ...base, container: null }).statusText).toBe('Container fehlt');
    expect(gameState({ ...base, connected: false }).statusText).toBe('Server offline');
    expect(gameState({ ...base, phase: 'stopped', container: null })).toMatchObject({
      status: 'off',
      statusText: 'Gestoppt',
    });
  });
});

describe('agent progress lines', () => {
  it('known phrases become German, unknown pass through', () => {
    expect(translateProgress('backup: 12.5 MiB written')).toBe('12,5 MiB geschrieben');
    expect(translateProgress('world saved, autosave paused')).toBe(
      'Welt gespeichert, Autosave pausiert',
    );
    expect(translateProgress('removed 2 old backup(s)')).toBe('2 alte Sicherung(en) entfernt');
    expect(translateProgress('$ tar --zstd -cf x -C y data')).toBe(
      'Archiv wird erstellt (tar.zst)',
    );
    expect(translateProgress('error: disk full')).toBe('Fehler: disk full');
    expect(translateProgress('something new')).toBe('something new');
  });

  it('parses only a valid result line', () => {
    expect(
      parseBackupResult('result {"path":"/opt/homelab/backups/a/a.tar.zst","sizeBytes":5}'),
    ).toEqual({ path: '/opt/homelab/backups/a/a.tar.zst', sizeBytes: 5 });
    expect(parseBackupResult('result {"path":"/etc/passwd","sizeBytes":5}')).toBe('invalid');
    expect(parseBackupResult('result {nope')).toBe('invalid');
    expect(parseBackupResult('backup: 1 MiB written')).toBeNull();
  });
});
