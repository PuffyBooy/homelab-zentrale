import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDisplayTimeZone } from '../../lib/format.js';
import { game, migration } from '../../test-fixtures.js';
import { MigrateIntro, SuggestView } from './MigrateDialog.js';
import { MigrationView } from './MigrationTile.js';

const noop = (): void => undefined;
const GB = 1024 ** 3;
const NOW = new Date('2026-11-26T22:04:00.000Z');

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

describe('Umziehen dialog', () => {
  it('says the game is stopped for a short time', () => {
    const out = html(<MigrateIntro game={game({ serverName: 'heimserver' })} />);
    expect(out).toContain('Der Gameserver wird dafür kurz gestoppt.');
    expect(out).toContain('bleibt survival auf heimserver');
  });

  it('shows new ports, changed ports, forwarding hint and free RAM', () => {
    const out = html(
      <SuggestView
        game={game()}
        target={{ name: 'oracle-a1' }}
        s={{
          ports: { game: 25570 },
          changed: [
            { name: 'game', protocol: 'tcp', count: 1, from: 25565, to: 25570, local: false },
          ],
          forwardingHint: 'Portweiterleitung am Ziel einrichten: game 25570 (TCP)',
          freeRamBytes: Math.round(8.2 * GB),
          ramWarning: null,
        }}
      />,
    );
    expect(out).toContain('game 25570/TCP');
    expect(out).toContain('game 25565 → 25570/TCP');
    expect(out).toContain('8,2 GB auf oracle-a1');
    expect(out).toContain('hz-alert-warn');
    expect(out).toContain('Portweiterleitung am Ziel einrichten: game 25570 (TCP)');
  });

  it('RAM warning and no forwarding needed', () => {
    const out = html(
      <SuggestView
        game={game()}
        target={{ name: 'pi' }}
        s={{
          ports: { game: 25565 },
          changed: [],
          forwardingHint: null,
          freeRamBytes: Math.round(2.1 * GB),
          ramWarning: 'Zu wenig RAM, 2,1 GB frei',
        }}
      />,
    );
    expect(out).toContain('keine, gleiche Ports wie jetzt');
    expect(out).toContain('Zu wenig RAM, 2,1 GB frei');
    expect(out).toContain('Keine neue Portweiterleitung nötig.');
  });
});

describe('Umzug progress', () => {
  it('transfer: steps with shape and text, bytes in de-AT, Abbrechen', () => {
    const out = html(
      <MigrationView m={migration()} gameName="survival" now={NOW} onCancel={noop} />,
    );
    expect(out).toContain('Umzug nach oracle-a1');
    expect(out).toContain('data-phase="transfer"');
    expect(out).toContain('Sichern · fertig');
    expect(out).toContain('hz-status-busy');
    expect(out).toContain('Starten am Ziel · offen');
    expect(out).toContain('1,2 GB von 3,4 GB · 35 %');
    expect(out).toContain('>Abbrechen<');
  });

  it('start: no Abbrechen any more', () => {
    const out = html(
      <MigrationView
        m={migration({ phase: 'start' })}
        gameName="survival"
        now={NOW}
        onCancel={noop}
      />,
    );
    expect(out).not.toContain('>Abbrechen<');
  });

  it('failed: crit tile with error text and rollback', () => {
    const out = html(
      <MigrationView
        m={migration({
          phase: 'failed',
          failedPhase: 'transfer',
          error: 'checksum_mismatch',
          errorText: 'Prüfsumme am Ziel stimmt nicht.',
          rollback: 'Der alte Server ist unverändert und läuft weiter.',
          finishedAt: '2026-11-26T22:03:30.000Z',
        })}
        gameName="survival"
        now={NOW}
        onCancel={noop}
      />,
    );
    expect(out).toContain('hz-tile-crit');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('Prüfsumme am Ziel stimmt nicht.');
    expect(out).toContain('Der alte Server ist unverändert und läuft weiter.');
    expect(out).not.toContain('>Abbrechen<');
  });

  it('done: link to the target and the new ports', () => {
    const out = html(
      <MigrationView
        m={migration({
          phase: 'done',
          progress: { bytesDone: Math.round(3.4 * GB), bytesTotal: Math.round(3.4 * GB) },
          finishedAt: '2026-11-26T22:03:30.000Z',
          forwardingHint: 'Portweiterleitung am Ziel einrichten: game 25570 (TCP)',
        })}
        gameName="survival"
        now={NOW}
        onCancel={noop}
      />,
    );
    expect(out).toContain('survival läuft jetzt auf oracle-a1.');
    expect(out).toContain('href="/servers/srv-000002"');
    expect(out).toContain('game 25570/TCP');
    expect(out).toContain('23:03');
    expect(out).toContain('Portweiterleitung am Ziel einrichten');
  });
});
