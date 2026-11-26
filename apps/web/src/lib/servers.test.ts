import { describe, expect, it } from 'vitest';
import {
  downNote,
  sentenceText,
  serverSentence,
  sortServers,
  statusSentence,
  switchEntries,
  toServerInfo,
} from './servers.js';
import { server } from '../test-fixtures.js';

describe('sortServers', () => {
  it('puts crit, then warn, then the rest by name', () => {
    const list = [
      server({ name: 'pi' }),
      server({ name: 'oracle-a1', status: 'warn' }),
      server({ name: 'heimserver' }),
      server({ name: 'web-vps', status: 'crit' }),
      server({ name: 'alt', status: 'off' }),
    ];
    expect(sortServers(list).map((s) => s.name)).toEqual([
      'web-vps',
      'oracle-a1',
      'alt',
      'heimserver',
      'pi',
    ]);
    // Input untouched.
    expect(list[0]?.name).toBe('pi');
  });
});

describe('statusSentence', () => {
  it('has a text for no servers', () => {
    expect(sentenceText(statusSentence([]))).toBe('Noch nichts verbunden.');
  });

  it('says "Alles läuft." when all are ok', () => {
    expect(statusSentence([server(), server()])).toEqual({ em: null, rest: 'Alles läuft.' });
  });

  it('counts problems first, then running servers', () => {
    const s = statusSentence([
      server(),
      server(),
      server({ status: 'warn' }),
      server({ status: 'crit' }),
    ]);
    expect(s).toEqual({ em: '2 Probleme', rest: ' · 3 von 4 Servern laufen' });
  });

  it('names the server when there is only one problem', () => {
    const s = statusSentence([server(), server({ name: 'oracle-a1', status: 'warn' })]);
    expect(sentenceText(s)).toBe('1 Problem auf oracle-a1 · 2 von 2 Servern laufen');
  });

  it('uses singular for one running server', () => {
    const s = statusSentence([server({ status: 'crit', name: 'a' }), server({ name: 'b' })]);
    expect(sentenceText(s)).toBe('1 Problem auf a · 1 von 2 Servern läuft');
  });

  it('counts open alerts without a known server', () => {
    const s = statusSentence(
      [server()],
      [
        { level: 'crit', state: 'open', serverId: null },
        { level: 'crit', state: 'resolved', serverId: null },
        { level: 'info', state: 'open', serverId: null },
      ],
    );
    expect(sentenceText(s)).toBe('1 Problem · 1 von 1 Server läuft');
  });
});

describe('serverSentence', () => {
  it('describes one server', () => {
    expect(sentenceText(serverSentence(server({ name: 'heimserver' })))).toBe('heimserver läuft.');
    expect(
      sentenceText(
        serverSentence(
          server({
            name: 'oracle-a1',
            status: 'warn',
            reasons: [{ level: 'warn', code: 'ram_warn', text: 'RAM bei 92 %' }],
          }),
        ),
      ),
    ).toBe('1 Problem auf oracle-a1 · RAM bei 92 %');
  });
});

describe('toServerInfo', () => {
  it('maps the summary to ServerList props', () => {
    const info = toServerInfo(server({ id: 'abcdefgh', name: 'heimserver' }));
    expect(info).toMatchObject({
      id: 'abcdefgh',
      name: 'heimserver',
      where: 'Zuhause',
      ip: '100.64.0.1',
      status: 'ok',
      cpu: 23,
      ram: 48,
      disk: 81,
      uptime: '41 T',
    });
    expect(info.note).toBeUndefined();
  });

  it('shows the crit reason in place of the bars', () => {
    const s = server({
      status: 'crit',
      connected: false,
      reasons: [{ level: 'crit', code: 'offline', text: 'kein Kontakt seit 23:02' }],
    });
    expect(toServerInfo(s).note).toBe('kein Kontakt seit 23:02');
    expect(downNote(server({ status: 'crit', connected: true }))).toBe('nicht erreichbar');
  });

  it('builds switch entries with "Alle Server" first', () => {
    const e = switchEntries([server({ name: 'b' }), server({ name: 'a', status: 'crit' })]);
    expect(e.map((x) => x.name)).toEqual(['Alle Server', 'a', 'b']);
  });
});
