import { MODULE_DEFAULTS, type Modules } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { authStateKey } from '../../lib/auth.js';
import { azurePricesKey, cloudKey } from '../../lib/cloud.js';
import { setDisplayTimeZone } from '../../lib/format.js';
import { gamesKey, templatesKey } from '../../lib/games.js';
import { serversKey } from '../../lib/servers.js';
import { azure, machine, overview, prices } from '../../test-cloud.js';
import { game, server, template } from '../../test-fixtures.js';
import { GameCreatePage } from '../games/GameCreatePage.js';
import { AzureTile } from './AzureTile.js';
import { BudgetTile } from './CloudPage.js';
import { DeleteMachineDialog } from './DeleteMachineDialog.js';
import { MachinesTile } from './MachinesTile.js';

const NOW = new Date('2026-11-26T22:08:00.000Z');
const noop = (): void => undefined;

function html(el: ReactElement, seed: (qc: QueryClient) => void = noop, path = '/'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

const PRICE_Q = {
  region: 'germanywestcentral',
  diskType: 'StandardSSD_LRS',
  diskGb: 32,
  publicIp: true,
} as const;

function createPage(modules: Partial<Modules>, path: string, azureStatus = 'ok' as const): string {
  return html(
    <Routes>
      <Route path="/games/new" element={<GameCreatePage />} />
    </Routes>,
    (qc) => {
      qc.setQueryData(authStateKey, {
        setupRequired: false,
        authenticated: true,
        modules: { ...MODULE_DEFAULTS, games: true, ...modules },
      });
      qc.setQueryData(templatesKey, [template({ arch: ['amd64'] })]);
      qc.setQueryData(serversKey, [
        server({ id: 'srv-amd00001', name: 'heimserver', arch: 'x86_64' }),
      ]);
      qc.setQueryData(gamesKey, []);
      qc.setQueryData(cloudKey, overview({ azure: azure({ status: azureStatus }) }));
      qc.setQueryData(azurePricesKey(PRICE_Q), prices());
    },
    path,
  );
}

describe('gameserver form with target "Neuer Azure-Server"', () => {
  it('module off: no Azure option', () => {
    const out = createPage({ cloud: false }, '/games/new?vorlage=minecraft-java');
    expect(out).not.toContain('Neuer Azure-Server');
  });

  it('module on and Azure set up: the option is there', () => {
    const out = createPage({ cloud: true }, '/games/new?vorlage=minecraft-java');
    expect(out).toContain('<option value="cloud:azure">Neuer Azure-Server …</option>');
  });

  it('Azure not set up (status off): no option', () => {
    const out = html(
      <Routes>
        <Route path="/games/new" element={<GameCreatePage />} />
      </Routes>,
      (qc) => {
        qc.setQueryData(authStateKey, {
          setupRequired: false,
          authenticated: true,
          modules: { ...MODULE_DEFAULTS, games: true, cloud: true },
        });
        qc.setQueryData(templatesKey, [template()]);
        qc.setQueryData(serversKey, [server()]);
        qc.setQueryData(gamesKey, []);
        qc.setQueryData(cloudKey, overview({ azure: azure({ status: 'off' }) }));
      },
      '/games/new?vorlage=minecraft-java',
    );
    expect(out).not.toContain('Neuer Azure-Server');
  });

  it('preselects B2ms for Minecraft, shows costs, keeps "Bestellen" disabled until confirmed', () => {
    const out = createPage({ cloud: true }, '/games/new?vorlage=minecraft-java&server=cloud:azure');
    expect(out).toContain('data-testid="cloud-order"');
    expect(out).toMatch(
      /<option value="Standard_B2ms" selected="">B2ms · 2 vCPU · 8 GB RAM[^<]*Empfohlen/,
    );
    expect(out).toMatch(/<option value="Standard_B2s" disabled="">[^<]*zu wenig RAM, braucht 5 GB/);
    expect(out).toMatch(/<option value="Standard_B2ats_v2" disabled="">[^<]*Free-Tier/);
    // Machine name "hz-" + game name (the game name is filled in after mount).
    expect(out).toMatch(/Name des Servers<\/label><input[^>]*value="hz-/);
    // Cost box with source.
    expect(out).toContain('Läuft: 0,10 €/Std · Schläft:');
    expect(out).toMatch(/Dauerbetrieb: \d+ €\/Monat/);
    expect(out).toContain('>Schätzung<');
    expect(out).toContain('Budget im Rahmen');
    // Required confirmation, unchecked; the main action is disabled.
    expect(out).toContain('Ich bestelle diesen Server für ca. 0,10 €/Std. bei Azure');
    expect(out).toMatch(/<input type="checkbox" required=""\/>/);
    expect(out).toMatch(
      /<button disabled="" class="hz-btn hz-btn-primary[^"]*" type="submit">(?:(?!<\/button>).)*Bestellen und aufsetzen/,
    );
    // No port forwarding hint for the home router.
    expect(out).toContain('data-testid="cloud-forward"');
  });

  it('budget used up: a second confirmation is shown', () => {
    const out = html(
      <Routes>
        <Route path="/games/new" element={<GameCreatePage />} />
      </Routes>,
      (qc) => {
        qc.setQueryData(authStateKey, {
          setupRequired: false,
          authenticated: true,
          modules: { ...MODULE_DEFAULTS, games: true, cloud: true },
        });
        qc.setQueryData(templatesKey, [template()]);
        qc.setQueryData(serversKey, [server()]);
        qc.setQueryData(gamesKey, []);
        qc.setQueryData(
          cloudKey,
          overview({
            budget: { limitEur: 20, monthEur: 20.4, projectedEur: 31, percent: 102, state: 'over' },
          }),
        );
        qc.setQueryData(azurePricesKey(PRICE_Q), prices());
      },
      '/games/new?vorlage=minecraft-java&server=cloud:azure',
    );
    expect(out).toContain('Cloud-Budget aufgebraucht.');
    expect(out).toContain('Trotz aufgebrauchtem Budget bestellen');
    expect(out).toContain('hz-status-crit');
  });
});

describe('Cloud page', () => {
  it('Azure-Zugang never renders secrets back, only "gespeichert"', () => {
    const out = html(<AzureTile settings={azure()} now={NOW} />);
    const pw = out.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    expect(pw).toHaveLength(2);
    for (const input of pw) {
      expect(input).toContain('value=""');
      expect(input).toContain('placeholder="gespeichert"');
    }
    expect(out).toContain('gespeichert · leer lassen = unverändert');
    expect(out).toContain('value="11111111-2222-3333-4444-555555555555"');
    expect(out).toContain('Azure verbunden');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('Verbindung testen');
    expect(out).toContain('Deutschland West-Mitte (Frankfurt)');
    expect(out).toContain('OFFENE-FRAGEN-UND-IDEEN.md');
  });

  it('Azure error: status with shape and the fixed error text; save is the main action', () => {
    const out = html(
      <AzureTile settings={azure({ status: 'error', error: 'Zugangsdaten ungültig' })} now={NOW} />,
    );
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('Azure-Fehler: Zugangsdaten ungültig');
    expect(out).toMatch(/hz-btn-primary[^>]*><span>Speichern/);
  });

  it('budget tile: month of limit, bar, projection and state', () => {
    const out = html(
      <BudgetTile
        budget={{ limitEur: 20, monthEur: 17, projectedEur: 24.5, percent: 85, state: 'warn' }}
      />,
    );
    expect(out).toContain('17,00 € von 20,00 € · 85 %');
    expect(out).toContain('Budget fast aufgebraucht');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('24,5');
    expect(out).toContain('hz-usage');
  });

  it('machines: state with shape and text, costs, IP, linked games; delete blocked while games exist', () => {
    const out = html(
      <MachinesTile
        machines={[
          machine(),
          machine({
            id: 'mach-00000002',
            name: 'hz-valheim',
            state: 'installing',
            stateText: 'Docker wird installiert',
            gameIds: [],
            pendingGameName: 'valheim',
            publicIp: null,
          }),
          machine({
            id: 'mach-00000003',
            name: 'hz-alt',
            state: 'deallocated',
            stateText: 'Schläft (nur Speicherkosten)',
            gameIds: [],
          }),
        ]}
        games={[game({ id: 'game-0001', name: 'mc-freunde' })]}
        onAction={noop}
        onIdle={noop}
      />,
    );
    expect(out).toContain('1 von 3 laufen');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('>UP<');
    expect(out).toContain('hz-status-busy');
    expect(out).toContain('Docker wird installiert');
    expect(out).toContain('hz-status-off');
    expect(out).toContain('Schläft (nur Speicherkosten)');
    expect(out).toContain('B2ms · 2 vCPU · 8 GB RAM · Deutschland West-Mitte (Frankfurt)');
    expect(out).toContain('20.79.1.23');
    expect(out).toContain('läuft 0,10 €/Std · schläft 5,66 €/Monat');
    expect(out).toContain('12,5 h · 3,10 €');
    expect(out).toContain('href="/games/game-0001"');
    expect(out).toContain('valheim (wird angelegt, sobald der Server bereit ist)');
    expect(out).toContain('Schlafen legen');
    expect(out).toContain('Starten');
    expect(out).toContain('Löschen geht erst ohne Gameserver');
    // First machine has a game: its delete button is disabled.
    expect(out).toMatch(/disabled="" title="Erst die Gameserver darauf löschen"/);
    expect(out).not.toContain('hz-btn-primary');
  });

  it('failed machine shows the fixed error text', () => {
    const out = html(
      <MachinesTile
        machines={[
          machine({
            state: 'failed',
            stateText: 'Fehler',
            error: 'Kontingent der Region erschöpft',
          }),
        ]}
        games={[]}
        onAction={noop}
        onIdle={noop}
      />,
    );
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('hz-mc-freunde: Kontingent der Region erschöpft');
  });

  it('delete dialog: typing the name is required', () => {
    const out = html(<DeleteMachineDialog machine={machine({ gameIds: [] })} onClose={noop} />);
    expect(out).toContain('hz-mc-freunde löschen');
    expect(out).toContain('placeholder="hz-mc-freunde"');
    expect(out).toContain('<button disabled="" class="hz-btn hz-btn-danger');
    expect(out).toContain('Code');
  });
});
