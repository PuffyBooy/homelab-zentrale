import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { game, gameRelay, server } from '../../test-fixtures.js';
import { ForwardHint } from './ForwardHint.js';
import { GameTile } from './GameTile.js';
import { SuggestView } from './MigrateDialog.js';
import { RelayTile } from './RelayTile.js';

const noop = (): void => undefined;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const suggest = {
  ports: { game: 25565 },
  changed: [],
  forwardingHint: 'Portweiterleitung am Ziel einrichten: game 25565 (TCP)',
  freeRamBytes: null,
  ramWarning: null,
};

describe('M15 relay in the game pages', () => {
  it('"Erreichbar über" shows ingress, state with text, DNS and the address to copy', () => {
    const out = html(<RelayTile game={game({ relay: gameRelay({ state: 'pending' }) })} />);
    expect(out).toContain('Erreichbar über');
    expect(out).toContain('oracle-a1');
    expect(out).toContain('Wartet auf den Eingang');
    expect(out).toContain('mc.example.org:25565');
    expect(out).toContain('Kopieren');
    expect(out).toContain('zeigt auf den Eingang');
  });

  it('"Erreichbar über" without relay says direct', () => {
    const out = html(<RelayTile game={game({ serverName: 'heimserver' })} />);
    expect(out).toContain('Direkt');
    expect(out).toContain('Portweiterleitung zu heimserver');
  });

  it('error state shows the error of the ingress', () => {
    const out = html(
      <RelayTile
        game={game({ relay: gameRelay({ state: 'error', error: 'Port 25565 belegt' }) })}
      />,
    );
    expect(out).toContain('Fehler am Eingang');
    expect(out).toContain('Port 25565 belegt');
  });

  it('ForwardHint with relay needs no router forwarding', () => {
    const ports = [{ name: 'game', port: 25565, protocol: 'tcp' as const }];
    const out = html(
      <ForwardHint ports={ports} server={server()} relay={{ ingressName: 'oracle-a1' }} />,
    );
    expect(out).toContain('Kein Router-Portforwarding nötig.');
    expect(out).toContain('Eingang oracle-a1');
    expect(out).not.toContain('Zuhause (Router)');
  });

  it('game tile shows "über <Eingang>"', () => {
    const out = html(<GameTile game={game({ relay: gameRelay() })} onConsole={noop} />);
    expect(out).toContain('über oracle-a1');
    expect(html(<GameTile game={game()} onConsole={noop} />)).not.toContain('über oracle-a1');
  });

  it('migrate dialog: address stays instead of the forwarding warning', () => {
    const out = html(
      <SuggestView game={game({ relay: gameRelay() })} target={{ name: 'pi' }} s={suggest} />,
    );
    expect(out).toContain('Adresse bleibt gleich (über oracle-a1).');
    expect(out).not.toContain('Portweiterleitung am Ziel einrichten');
    const direct = html(<SuggestView game={game()} target={{ name: 'pi' }} s={suggest} />);
    expect(direct).toContain('Portweiterleitung am Ziel einrichten');
  });
});
