import {
  defaultThrottleSettings,
  type ServerThrottleResponse,
  type TopConsumer,
  type TopConsumersResponse,
} from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, game } from '../../test-fixtures.js';
import { ContainerRow } from '../containers/ContainerRow.js';
import { GameTile } from '../games/GameTile.js';
import { AutomatikForm } from './AutomatikTile.js';
import { ContainerThrottleTile } from './ContainerThrottleTile.js';
import { ContainerPriorityBody, GamePriorityTile } from './PriorityTile.js';
import { StopConfirmDialog, ThrottleDialog } from './ThrottleDialogs.js';
import { RestartAutostopButton } from './RestartAutostopButton.js';
import { ConsumerRow, TopConsumersTile } from './TopConsumersTile.js';

const GB = 1024 ** 3;
const NOW = new Date('2026-11-26T22:04:00.000Z');
const noop = (): void => undefined;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

afterEach(() => vi.unstubAllGlobals());

const throttled = {
  cpus: 1,
  since: '2026-11-26T22:04:00.000Z',
  by: 'auto' as const,
  reason: 'heimserver CPU 96 % seit 2 Min',
};

describe('priority section', () => {
  it('container: select with three tiers, stop only with niedrig', () => {
    const out = html(<ContainerPriorityBody c={container({ name: 'my-app' })} />);
    expect(out).toContain('>Priorität</label>');
    expect(out).toMatch(/<option value="wichtig">wichtig/);
    expect(out).toMatch(/<option value="normal" selected="">normal/);
    expect(out).toMatch(/<option value="niedrig">niedrig/);
    expect(out).toContain('aria-label="darf gestoppt werden"');
    expect(out).toContain('nur bei Priorität niedrig');
    expect(out).toMatch(/hz-toggle hz-toggle-disabled/);
    expect(out).not.toContain('auch mit Spielern online');
  });

  it('container niedrig: the stop switch is on and usable', () => {
    const out = html(
      <ContainerPriorityBody c={container({ priority: 'niedrig', allowStop: true })} />,
    );
    expect(out).not.toContain('hz-toggle-disabled');
    expect(out).toContain('aria-checked="true" aria-label="darf gestoppt werden"');
  });

  it('protected container: read only, always wichtig', () => {
    const out = html(
      <ContainerPriorityBody
        c={container({ name: 'hz-core', protected: true, priority: 'wichtig' })}
      />,
    );
    expect(out).toContain('Zentrale/Agent: immer wichtig');
    expect(out).not.toContain('<select');
    expect(out).not.toContain('type="submit"');
  });

  it('game container: points to the game page', () => {
    const out = html(
      <ContainerPriorityBody c={container({ name: 'game-survival', gameId: 'game-000042' })} />,
    );
    expect(out).toContain('href="/games/game-000042"');
    expect(out).toContain('Zum Gameserver');
    expect(out).not.toContain('<select');
  });

  it('game: also "auch mit Spielern online", needs "darf gestoppt werden"', () => {
    const off = html(<GamePriorityTile game={game({ priority: 'niedrig', allowStop: false })} />);
    expect(off).toContain('aria-label="auch mit Spielern online"');
    expect(off).toContain('braucht „darf gestoppt werden“');
    const on = html(
      <GamePriorityTile
        game={game({ priority: 'niedrig', allowStop: true, allowStopWithPlayers: true })}
      />,
    );
    expect(on).toContain('aria-checked="true" aria-label="auch mit Spielern online"');
  });
});

describe('throttle hints in lists', () => {
  it('container row shows "gedrosselt (1 Kern)" with the reason as tooltip', () => {
    const out = html(<ContainerRow c={container({ name: 'minecraft', throttled })} now={NOW} />);
    expect(out).toContain('hz-badge hz-badge-warn');
    expect(out).toContain('gedrosselt (1 Kern)');
    expect(out).toContain('heimserver CPU 96 % seit 2 Min');
  });

  it('container row shows "automatisch gestoppt"', () => {
    const out = html(
      <ContainerRow
        c={container({ state: 'exited', status: 'off', exitCode: 0, autoStopped: true })}
        now={NOW}
      />,
    );
    expect(out).toContain('automatisch gestoppt');
  });

  it('plain rows have no badge', () => {
    expect(html(<ContainerRow c={container()} now={NOW} />)).not.toContain('hz-badge');
  });

  it('game tile shows the hint', () => {
    expect(
      html(<GameTile game={game({ throttled: { ...throttled, cpus: 0.5 } })} onConsole={noop} />),
    ).toContain('gedrosselt (0,5 Kerne)');
    expect(
      html(<GameTile game={game({ autoStopped: true, status: 'off' })} onConsole={noop} />),
    ).toContain('automatisch gestoppt');
  });
});

describe('manual throttle in container detail', () => {
  it('offers "Drosseln …" while running', () => {
    const out = html(<ContainerThrottleTile c={container()} />);
    expect(out).toContain('Drosseln …');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).not.toContain('Drosselung aufheben');
    expect(out).toContain('nicht gedrosselt');
  });

  it('offers "Drosselung aufheben" when throttled', () => {
    const out = html(<ContainerThrottleTile c={container({ throttled })} />);
    expect(out).toContain('Drosselung aufheben');
    expect(out).toContain('gedrosselt auf 1 Kern');
    expect(out).toContain('hz-status-warn');
  });

  it('has no buttons for protected containers', () => {
    const out = html(<ContainerThrottleTile c={container({ protected: true })} />);
    expect(out).toContain('Zentrale/Agent: wird nie gedrosselt oder gestoppt.');
    expect(out).not.toContain('<button');
  });

  it('the dialog asks for 0,1 to 64 cores', () => {
    const out = html(
      <ThrottleDialog
        target={{ id: 'ctr-000001', name: 'minecraft', serverName: 'heimserver' }}
        onClose={noop}
      />,
    );
    expect(out).toContain('minecraft drosseln');
    expect(out).toContain('CPU-Anteil (Kerne)');
    expect(out).toContain('value="1"');
    expect(out).toContain('0,1 bis 64');
  });
});

function consumer(over: Partial<TopConsumer> = {}): TopConsumer {
  return {
    containerId: 'ctr-000001',
    containerName: 'minecraft',
    serverId: 'srv-1',
    serverName: 'heimserver',
    cpuPct: 96.4,
    memBytes: 5.8 * GB,
    priority: 'niedrig',
    protected: false,
    throttled: null,
    isGame: true,
    gameId: 'game-000001',
    ...over,
  };
}

/** Buttons in a rendered element tree (no DOM in these tests). */
function buttons(node: ReactNode): { label: string; onClick: () => void; popup: unknown }[] {
  const out: { label: string; onClick: () => void; popup: unknown }[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    const p = n.props as Record<string, unknown>;
    if (typeof p.onClick === 'function' && typeof p['aria-label'] === 'string') {
      out.push({
        label: p['aria-label'],
        onClick: p.onClick as () => void,
        popup: p['aria-haspopup'],
      });
    }
    walk(p.children as ReactNode);
    walk(p.actions as ReactNode);
  };
  walk(node);
  return out;
}

describe('"Wer frisst gerade?"', () => {
  const data: TopConsumersResponse = {
    byCpu: [
      consumer(),
      consumer({
        containerId: 'ctr-000002',
        containerName: 'hz-core',
        protected: true,
        priority: 'wichtig',
        cpuPct: 41,
        isGame: false,
        gameId: null,
      }),
      consumer({
        containerId: 'ctr-000003',
        containerName: 'jellyfin',
        serverName: 'oracle-a1',
        cpuPct: 8.25,
        throttled,
        isGame: false,
        gameId: null,
      }),
    ],
    byRam: [consumer()],
    updatedAt: '2026-11-26T22:04:00.000Z',
  };

  it('lists CPU and RAM, with de-AT numbers', () => {
    const out = html(<TopConsumersTile data={data} />);
    expect(out).toContain('Wer frisst gerade?');
    expect(out).toContain('aria-label="CPU"');
    expect(out).toContain('aria-label="RAM"');
    expect(out).toContain('CPU 96 %');
    expect(out).toContain('CPU 8,3 % · gedrosselt (1 Kern)');
    expect(out).toContain('RAM 5,8 GB');
    expect(out).toContain('heimserver · Zentrale/Agent');
  });

  it('protected entries have no buttons, others Drosseln/Aufheben/Stoppen', () => {
    const out = html(<TopConsumersTile data={data} />);
    expect(out).not.toContain('hz-core drosseln');
    expect(out).not.toContain('hz-core stoppen');
    expect(out).toContain('aria-label="minecraft drosseln"');
    expect(out).toContain('aria-label="minecraft stoppen"');
    expect(out).toContain('aria-label="Drosselung von jellyfin aufheben"');
    expect(out).not.toContain('aria-label="jellyfin drosseln"');
  });

  it('"Stoppen" only asks: it opens the confirm dialog, nothing is sent', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const onStop = vi.fn();
    const c = consumer();
    const tree = ConsumerRow({
      c,
      by: 'cpu',
      onThrottle: noop,
      onUnthrottle: noop,
      onStop,
      busy: false,
    });
    const stop = buttons(tree).find((b) => b.label === 'minecraft stoppen');
    expect(stop?.popup).toBe('dialog');
    stop?.onClick();
    expect(onStop).toHaveBeenCalledWith(c);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the confirm dialog names the container and server, with Abbrechen first', () => {
    const out = html(
      <StopConfirmDialog
        target={{ id: 'ctr-000001', name: 'minecraft', serverName: 'heimserver' }}
        isGame
        onClose={noop}
      />,
    );
    expect(out).toContain('minecraft stoppen?');
    expect(out).toContain('minecraft auf heimserver wird gestoppt');
    expect(out).toContain('werden getrennt');
    expect(out.indexOf('Abbrechen')).toBeLessThan(out.lastIndexOf('Stoppen'));
    expect(out).toContain('hz-btn-danger');
  });

  it('protected rows render no action buttons at all', () => {
    const tree = ConsumerRow({
      c: consumer({ protected: true }),
      by: 'ram',
      onThrottle: noop,
      onUnthrottle: noop,
      onStop: noop,
      busy: false,
    });
    expect(buttons(tree)).toEqual([]);
  });
});

describe('Automatik', () => {
  const data: ServerThrottleResponse = {
    serverId: 'srv-1',
    settings: defaultThrottleSettings,
    schedules: [
      {
        tier: 'niedrig',
        days: ['mo', 'di', 'mi', 'do', 'fr'],
        from: '18:00',
        to: '23:00',
        mode: 'no_throttle',
      },
      { tier: 'normal', days: ['sa'], from: '22:00', to: '02:00', mode: 'cpus', cpus: 2 },
    ],
    status: {
      phase: 'throttled',
      since: '2026-11-26T22:04:00.000Z',
      ramReserveBytes: 2 * GB,
      freeRamBytes: 7.8 * GB,
      activeWindows: [1],
    },
  };

  it('shows switch, thresholds, phase, RAM and the time zone', () => {
    const out = html(
      <AutomatikForm data={data} serverName="heimserver" timeZone="Europe/Vienna" />,
    );
    expect(out).toContain('aria-checked="true" aria-label="Automatik"');
    expect(out).toContain('CPU über (%)');
    expect(out).toContain('value="90"');
    expect(out).toContain('RAM-Reserve (GB)');
    expect(out).toContain('0 = automatisch');
    expect(out).toContain('Drosseln auf (Kerne)');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('Gedrosselt seit');
    expect(out).toContain('RAM frei 7,8 GB · Reserve 2 GB');
    expect(out).toContain('Zeitzone: Europe/Vienna');
  });

  it('edits windows: tier, days Mo–So, from/to, mode and cores', () => {
    const out = html(
      <AutomatikForm data={data} serverName="heimserver" timeZone="Europe/Vienna" />,
    );
    expect(out).toContain('Zeitpläne · 2 von 20');
    expect(out).toContain('aria-label="Zeitfenster 1"');
    expect(out).toMatch(/aria-pressed="true" title="Montag"[^>]*><span>Mo</);
    expect(out).toMatch(/aria-pressed="false" title="Samstag"[^>]*><span>Sa</);
    expect(out).toMatch(/<option value="no_throttle" selected="">ohne Drosselung/);
    expect(out).toMatch(/<option value="cpus" selected="">mit X Kernen/);
    expect(out).toContain('value="18:00"');
    expect(out).toContain('value="02:00"');
    expect(out).toContain('>Kerne</label>');
    expect(out).toContain('>aktiv</span>');
    expect(out).toContain('Zeitfenster hinzufügen');
  });

  it('stops at 20 windows', () => {
    const first = data.schedules.slice(0, 1);
    const many = {
      ...data,
      schedules: Array.from({ length: 20 }, () => first).flat(),
      status: { ...data.status, activeWindows: [] },
    };
    const out = html(<AutomatikForm data={many} serverName="heimserver" timeZone={undefined} />);
    expect(out).toContain('Höchstens 20 Zeitfenster.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Zeitfenster hinzufügen/);
    expect(out).toContain('Zeitzone: unbekannt');
  });
});

describe('"Wieder starten" on autostop alerts', () => {
  it('shows the button for an auto-stopped container, not for a running one', () => {
    const stopped = container({
      name: 'cruncher',
      state: 'exited',
      status: 'off',
      autoStopped: true,
    });
    const out = html(
      <RestartAutostopButton
        alertKey={`autostop:${stopped.serverId}:cruncher`}
        containers={[stopped]}
        onError={noop}
      />,
    );
    expect(out).toContain('aria-label="cruncher wieder starten"');
    expect(out).toContain('Wieder starten');
    const running = container({ name: 'cruncher' });
    expect(
      html(
        <RestartAutostopButton
          alertKey={`autostop:${running.serverId}:cruncher`}
          containers={[running]}
          onError={noop}
        />,
      ),
    ).toBe('');
  });
});
