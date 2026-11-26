import { describe, expect, it } from 'vitest';
import { check, server } from '../test-fixtures.js';
import {
  checkCode,
  checkMatchesServer,
  checkSentence,
  checkSubline,
  checkTarget,
  checkToForm,
  checksSentence,
  daysUntil,
  defaultName,
  emptyCheckForm,
  formToDef,
  formatDays,
  formatMs,
  formatUptime,
  historyStats,
  outages,
  sortChecks,
} from './checks.js';
import { sentenceText } from './servers.js';

const NOW = new Date('2026-11-25T22:04:00.000Z');

describe('check presentation', () => {
  it('sorts problems first, then by name', () => {
    const list = [
      check({ def: { name: 'b.at' } }),
      check({ def: { name: 'a.at' }, status: 'off' }),
      check({ def: { name: 'z.at' }, status: 'crit' }),
      check({ def: { name: 'c.at' }, status: 'warn' }),
    ];
    expect(sortChecks(list).map((c) => c.def.name)).toEqual(['z.at', 'c.at', 'b.at', 'a.at']);
  });

  it('shows the target per kind', () => {
    expect(checkTarget(check({ def: { url: 'https://sc-ball.at/' } }).def)).toBe('sc-ball.at');
    expect(checkTarget(check({ def: { url: 'https://hoebe.at/api?x=1' } }).def)).toBe(
      'hoebe.at/api',
    );
    const tcp = check({ def: { kind: 'tcp', host: 'mc.hoebe.at', port: 25565 } as never });
    expect(checkTarget(tcp.def)).toBe('mc.hoebe.at:25565');
    expect(checkCode(tcp)).toBe('TCP');
    expect(checkCode(check({ lastCode: 503 }))).toBe(503);
    expect(checkCode(check({ lastCode: null }))).toBeUndefined();
  });

  it('formats in Austrian style', () => {
    expect(formatUptime(99.954)).toBe('99,95 %');
    expect(formatUptime(100)).toBe('100 %');
    expect(formatUptime(null)).toBe('—');
    expect(formatMs(312.6)).toBe('313 ms');
    expect(formatMs(1240)).toBe('1240 ms');
    expect(formatDays(61)).toBe('in 61 T');
    expect(formatDays(0)).toBe('heute');
    expect(formatDays(-3)).toBe('seit 3 T abgelaufen');
    expect(daysUntil('2026-12-05T22:04:00.000Z', NOW)).toBe(10);
    expect(daysUntil(null, NOW)).toBeUndefined();
  });

  it('puts the reason first in the sub line', () => {
    const home = server({ id: 'srv-home0001', name: 'heimserver' });
    const c = check({
      def: { name: 'Lernplattform', url: 'https://lernen.hoebe.at/', runFrom: home.id },
      status: 'crit',
      reason: 'HTTP 503',
      uptime24h: 97.5,
      domainExpiresAt: '2026-12-10T00:00:00.000Z',
    });
    expect(checkSubline(c, [home], NOW)).toBe(
      'HTTP 503 · Lernplattform · von heimserver · 24 h 97,5 % · Domain in 14 T',
    );
    const paused = check({ def: { enabled: false, name: 'x.at', url: 'https://x.at/' } });
    expect(checkSubline(paused, [], NOW)).toBe('pausiert · von Zentrale · 24 h 100 %');
  });

  it('filters by linked server or the agent it runs from', () => {
    expect(checkMatchesServer(check({ def: { serverId: 'srv-a0000001' } }), 'srv-a0000001')).toBe(
      true,
    );
    expect(checkMatchesServer(check({ def: { runFrom: 'srv-a0000001' } }), 'srv-a0000001')).toBe(
      true,
    );
    expect(checkMatchesServer(check(), 'srv-a0000001')).toBe(false);
  });
});

describe('Statussatz', () => {
  it('names a single offline site', () => {
    const list = [
      check({ def: { url: 'https://lernen.hoebe.at/' }, status: 'crit' }),
      check(),
      check(),
    ];
    expect(sentenceText(checksSentence(list))).toBe(
      'lernen.hoebe.at ist nicht erreichbar · 2 von 3 Checks erreichbar',
    );
  });

  it('counts problems and says when all is fine', () => {
    expect(checksSentence([check(), check()])).toEqual({ em: null, rest: 'Alles erreichbar.' });
    expect(checksSentence([])).toEqual({ em: null, rest: 'Noch keine Checks.' });
    const two = checksSentence([check({ status: 'crit' }), check({ status: 'warn' }), check()]);
    expect(two).toEqual({ em: '2 Probleme', rest: ' · 2 von 3 Checks erreichbar' });
  });

  it('describes one check', () => {
    const c = check({
      def: { url: 'https://volontaers-alarm.app/' },
      status: 'warn',
      reason: 'SSL läuft in 9 Tagen ab',
    });
    expect(sentenceText(checkSentence(c))).toBe('volontaers-alarm.app: SSL läuft in 9 Tagen ab');
    expect(sentenceText(checkSentence(check({ def: { url: 'https://a.at/' } })))).toBe(
      'a.at ist erreichbar.',
    );
  });
});

describe('history', () => {
  const p = (ts: string, ok: boolean, ms: number | null, code: number | null = 200) => ({
    ts,
    ok,
    ms,
    code,
  });
  const points = [
    p('2026-11-25T22:00:00.000Z', true, 300),
    p('2026-11-25T22:01:00.000Z', false, null, 503),
    p('2026-11-25T22:02:00.000Z', false, null, 503),
    p('2026-11-25T22:03:00.000Z', true, 500),
  ];

  it('computes uptime, average and failures', () => {
    const s = historyStats(points);
    expect(s.uptime).toBe(50);
    expect(s.avgMs).toBe(400);
    expect(s.maxMs).toBe(500);
    expect(s.failures).toBe(2);
    expect(s.spark).toEqual([300, 500]);
    expect(historyStats([]).uptime).toBeNull();
  });

  it('merges consecutive failures into outages, newest first', () => {
    expect(outages(points)).toEqual([
      { from: '2026-11-25T22:01:00.000Z', to: '2026-11-25T22:02:00.000Z', count: 2, code: 503 },
    ]);
    const trailing = [...points, p('2026-11-25T22:04:00.000Z', false, null, null)];
    expect(outages(trailing).map((o) => o.from)).toEqual([
      '2026-11-25T22:04:00.000Z',
      '2026-11-25T22:01:00.000Z',
    ]);
  });
});

describe('check form', () => {
  it('builds a TCP check and names it after the target', () => {
    const f = { ...emptyCheckForm('tcp'), host: ' 127.0.0.1 ', port: '1' };
    const res = formToDef(f);
    expect(res).toEqual({
      ok: true,
      def: {
        kind: 'tcp',
        name: '127.0.0.1:1',
        runFrom: 'core',
        intervalS: 60,
        enabled: true,
        serverId: null,
        host: '127.0.0.1',
        port: 1,
      },
    });
  });

  it('builds an HTTP check with defaults and an optional text', () => {
    const res = formToDef({
      ...emptyCheckForm('http'),
      url: 'https://sc-ball.at',
      contains: 'SC Ball',
    });
    expect(res.ok && res.def).toMatchObject({
      kind: 'http',
      name: 'sc-ball.at',
      url: 'https://sc-ball.at',
      expectStatusMin: 200,
      expectStatusMax: 399,
      contains: 'SC Ball',
      certCheck: true,
    });
  });

  it('reports field errors in German', () => {
    const bad = formToDef({ ...emptyCheckForm('http'), url: 'ftp://x', intervalS: '5' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.url).toMatch(/http:\/\/ oder https:\/\//);
      expect(bad.errors.intervalS).toBe('Intervall zwischen 30 und 3600 s.');
    }
    const port = formToDef({ ...emptyCheckForm('tcp'), host: 'a', port: '70000' });
    expect(!port.ok && port.errors.port).toBe('Port zwischen 1 und 65535.');
    const host = formToDef({ ...emptyCheckForm('tcp'), host: 'evil host', port: '1' });
    expect(!host.ok && host.errors.host).toBeTruthy();
    const range = formToDef({
      ...emptyCheckForm('http'),
      url: 'https://a.at',
      expectStatusMin: '400',
      expectStatusMax: '200',
    });
    expect(!range.ok && range.errors.expectStatusMax).toBeTruthy();
    const creds = formToDef({ ...emptyCheckForm('http'), url: 'https://alex:geheim@a.at/' });
    expect(!creds.ok && creds.errors.url).toBe('URL ohne Benutzer und Passwort eintragen.');
  });

  it('needs an agent for ping', () => {
    const res = formToDef({ ...emptyCheckForm('ping'), host: '192.168.1.20' });
    expect(!res.ok && res.errors.runFrom).toBe('Ping läuft über einen Agent. Server wählen.');
    const ok = formToDef({
      ...emptyCheckForm('ping'),
      host: '192.168.1.20',
      runFrom: 'srv-a0000001',
    });
    expect(ok.ok).toBe(true);
  });

  it('round-trips an existing check', () => {
    const c = check({ def: { url: 'https://a.at/', contains: 'Hallo', serverId: 'srv-a0000001' } });
    const f = checkToForm(c.def);
    expect(f.serverId).toBe('srv-a0000001');
    const res = formToDef(f);
    expect(res.ok && res.def).toEqual(c.def);
    expect(defaultName({ ...emptyCheckForm('http'), url: 'kaputt' })).toBe('');
  });
});
