import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  modsKey,
  notifyKey,
  schedulesKey,
  statsKey,
  whitelistRequestsKey,
} from '../../lib/gameFeatures.js';
import { backupsKey, gamesKey, templatesKey } from '../../lib/games.js';
import { serversKey } from '../../lib/servers.js';
import { game, server, template } from '../../test-fixtures.js';
import { BackupsTile } from './BackupsTile.js';
import { GameCreatePage } from './GameCreatePage.js';
import { GameTile } from './GameTile.js';
import { ModsTile } from './ModsTile.js';
import { NotifyTile } from './NotifyTile.js';
import { SchedulesTile } from './SchedulesTile.js';
import { SettingsTile } from './SettingsTile.js';
import { ShareCreateDialog } from './ShareCreateDialog.js';
import { StatsTile } from './StatsTile.js';
import { WhitelistRequestsTile } from './WhitelistRequestsTile.js';

const now = new Date(2026, 10, 26, 23, 4);

function html(el: ReactElement, seed: (qc: QueryClient) => void = () => {}, path = '/'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const g = game({ id: 'game-0001' });

describe('sleep mode in tiles and settings', () => {
  it('the tile shows "Schläft" with the off ring', () => {
    const out = html(
      <GameTile
        game={game({ status: 'off', statusText: 'Schläft', sleeping: true, players: null })}
        onConsole={() => {}}
      />,
    );
    expect(out).toContain('hz-status hz-status-off');
    expect(out).toContain('>Schläft<');
    expect(out).not.toContain('>OFF<');
  });

  it('settings offer the sleep minutes and the wake switch only with template support', () => {
    const out = html(<SettingsTile game={g} tpl={template({ wake: true })} />);
    expect(out).toContain('Schlafen nach … Min ohne Spieler');
    expect(out).toContain('0 = nie.');
    expect(out).toContain('Beim Verbinden aufwecken');
    const noWake = html(<SettingsTile game={g} tpl={template({ wake: false })} />);
    expect(noWake).not.toContain('Beim Verbinden aufwecken');
  });

  it('a new game sleeps after 15 min and wakes on connect by default', () => {
    const out = html(
      <Routes>
        <Route path="/games/new" element={<GameCreatePage />} />
      </Routes>,
      (qc) => {
        qc.setQueryData(templatesKey, [template({ arch: ['amd64'] })]);
        qc.setQueryData(serversKey, [
          server({ id: 'srv-amd00001', name: 'heimserver', arch: 'x86_64' }),
          server({ id: 'srv-arm00001', name: 'pi', arch: 'aarch64' }),
        ]);
        qc.setQueryData(gamesKey, []);
      },
      '/games/new?vorlage=minecraft-java',
    );
    expect(out).toContain('value="15"');
    expect(out).toMatch(/Beim Verbinden aufwecken.*aria-checked="true"/s);
    // pi is shown but not selectable.
    expect(out).toContain(
      '<option value="srv-arm00001" disabled="">pi · Läuft nicht auf arm64</option>',
    );
    expect(out).toContain('<option value="srv-amd00001" selected="">heimserver</option>');
  });
});

describe('M12 tiles', () => {
  it('schedules list kind, days, time and next run', () => {
    const out = html(<SchedulesTile game={g} now={now} />, (qc) =>
      qc.setQueryData(schedulesKey(g.id), {
        schedules: [{ kind: 'backup', days: [1, 2, 3, 4, 5, 6, 7], time: '04:00', enabled: true }],
        next: [new Date(2026, 10, 27, 4, 0).toISOString()],
      }),
    );
    expect(out).toContain('Zeitpläne');
    expect(out).toContain('Backup · täglich · 04:00');
    expect(out).toContain('nächster Lauf 27.11. 04:00');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('Eintrag hinzufügen');
  });

  it('Discord shows only "gesetzt", never a URL', () => {
    const out = html(<NotifyTile game={g} now={now} />, (qc) =>
      qc.setQueryData(notifyKey(g.id), {
        discordSet: true,
        events: ['online', 'wake'],
        lastSentAt: null,
        lastError: 'Discord antwortet 404',
      }),
    );
    expect(out).toContain('>gesetzt<');
    expect(out).not.toContain('discord.com/api/webhooks/1');
    expect(out).toContain('type="password"');
    expect(out).toContain('Letzte Nachricht ging nicht: Discord antwortet 404');
    expect(out).toContain('Server wurde aufgeweckt');
  });

  it('statistics show play time, sessions, peak and the hour bars', () => {
    const hours = Array.from({ length: 24 }, (_, i) => (i === 20 ? 3 : 0.5));
    const out = html(<StatsTile game={g} now={now} />, (qc) =>
      qc.setQueryData(statsKey(g.id, 7), {
        days: 7,
        players: [
          { name: 'Sam', seconds: 12 * 3600 + 300, sessions: 9, lastSeen: now.toISOString() },
        ],
        hours,
        peak: { online: 7, at: new Date(2026, 10, 23, 21, 14).toISOString() },
        names: true,
      }),
    );
    expect(out).toContain('Statistik');
    expect(out).toContain('12 h 05 min');
    expect(out).toContain('9 Sitzungen · zuletzt 23:04');
    expect(out).toContain('7 Spieler · 23.11. 21:14');
    expect(out).toContain('20–21 Uhr · Ø 3 Spieler');
    expect(out).toContain('class="hz-spark hz-spark-muted"');
    expect(out).toContain('aria-pressed="true"');
  });

  it('whitelist requests: open ones on top with Bestätigen and Ablehnen', () => {
    const base = {
      gameId: g.id,
      shareId: 'share-0001',
      person: 'Lena',
      decidedAt: null,
    };
    const out = html(<WhitelistRequestsTile game={g} now={now} />, (qc) =>
      qc.setQueryData(whitelistRequestsKey(g.id), [
        {
          ...base,
          id: 'wlr-00000001',
          player: 'Alt_1',
          state: 'approved',
          createdAt: '2026-11-25T10:00:00.000Z',
          decidedAt: '2026-11-25T11:00:00.000Z',
        },
        {
          ...base,
          id: 'wlr-00000002',
          player: 'Neu_2',
          state: 'pending',
          createdAt: '2026-11-24T10:00:00.000Z',
        },
      ]),
    );
    expect(out).toContain('1 offen');
    expect(out.indexOf('Neu_2')).toBeLessThan(out.indexOf('Alt_1'));
    expect(out).toContain('aria-label="Neu_2 auf die Whitelist"');
    expect(out).toContain('aria-label="Anfrage von Neu_2 ablehnen"');
    expect(out).toContain('hz-status hz-status-warn');
    expect(out).toContain('>offen<');
    expect(out).toContain('>bestätigt<');
  });

  it('mods: files with remove, restart hint with button', () => {
    const out = html(<ModsTile game={g} kind="plugins" />, (qc) =>
      qc.setQueryData(modsKey(g.id), {
        kind: 'plugins',
        loader: 'paper',
        gameVersion: '1.21.4',
        files: [
          {
            fileName: 'EssentialsX-2.21.0.jar',
            sizeBytes: 1.2 * 1024 ** 2,
            title: 'EssentialsX',
            projectId: 'hXiIvTyT',
          },
        ],
        restartNeeded: true,
      }),
    );
    expect(out).toContain('Plugins');
    expect(out).toContain('EssentialsX');
    expect(out).toContain('aria-label="EssentialsX entfernen"');
    expect(out).toContain('Neustart nötig.');
    expect(out).toContain('Neu starten');
    expect(out).toContain('Plugins suchen');
  });

  it('every backup has a restore button', () => {
    const out = html(<BackupsTile game={g} now={now} />, (qc) =>
      qc.setQueryData(backupsKey(g.id), [
        {
          id: 'bak-00000001',
          fileName: 'survival-2026-11-26-0400.tar.zst',
          sizeBytes: 1.5 * 1024 ** 3,
          createdAt: new Date(2026, 10, 26, 4, 0).toISOString(),
        },
      ]),
    );
    expect(out).toContain('Wiederherstellen');
    expect(out).toContain('aria-label="Backup von 04:00 wiederherstellen"');
    expect(out).toContain('04:00 · 1,5 GB');
  });
});

describe('share rights', () => {
  it('Minecraft links offer world download and whitelist request', () => {
    const out = html(<ShareCreateDialog game={g} onClose={() => {}} />);
    expect(out).toContain('Welt herunterladen');
    expect(out).toContain('Whitelist-Anfrage');
    expect(out).toContain('Freund trägt seinen Namen ein, du bestätigst');
  });

  it('other games offer the world download only', () => {
    const out = html(
      <ShareCreateDialog game={game({ templateId: 'valheim' })} onClose={() => {}} />,
    );
    expect(out).toContain('Welt herunterladen');
    expect(out).not.toContain('Whitelist-Anfrage');
  });
});
