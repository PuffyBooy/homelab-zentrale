import { defaultSelfhealSettings, type SelfhealResponse, type Task } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { containersKey } from '../../lib/containers.js';
import { setDisplayTimeZone } from '../../lib/format.js';
import { ModuleOff } from '../../routes/ModuleGate.js';
import { check, container, server } from '../../test-fixtures.js';
import { SelfhealEventsTile, SelfhealRulesTile, StateRow } from './SelfhealTiles.js';
import { TaskForm } from './TaskDialog.js';
import { RunDetail } from './TaskRunsDialog.js';
import { TaskRow } from './TasksTile.js';

const NOW = new Date('2026-11-26T20:00:00.000Z');
const noop = (): void => undefined;

function html(el: ReactElement, qc = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

const home = server({ id: 'srv-home0001', name: 'heimserver' });
const pi = server({ id: 'srv-pi000001', name: 'pi' });

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-00000001',
    serverId: home.id,
    serverName: 'heimserver',
    name: 'Neustart nextcloud',
    action: { kind: 'container.restart', container: 'nextcloud' },
    schedule: { type: 'weekly', days: [1, 2, 3, 4, 5], times: ['04:00'] },
    enabled: true,
    notifyOnFailure: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: new Date('2026-11-27T03:00:00Z').getTime(),
    lastRun: {
      id: 'r1',
      taskId: 'task-00000001',
      trigger: 'schedule',
      state: 'failed',
      startedAt: new Date('2026-11-26T03:00:00Z').getTime(),
      finishedAt: null,
      durationMs: 1200,
      exitCode: 1,
      summary: 'Exit-Code 1',
      output: 'df: /mnt: No such file',
    },
    ...over,
  };
}

describe('task row', () => {
  it('shows server, kind, schedule, next and last run with shape and text', () => {
    const out = html(<TaskRow task={task()} now={NOW} onEdit={noop} onRuns={noop} />);
    expect(out).toContain('heimserver · Container neu starten · nextcloud · Mo–Fr um 04:00');
    expect(out).toContain('nächster Lauf 27.11. 04:00 · zuletzt 04:00 · Exit-Code 1');
    expect(out).toContain('hz-status hz-status-crit');
    expect(out).toContain('>DOWN<');
    expect(out).toContain('aria-label="Neustart nextcloud jetzt ausführen"');
    expect(out).toContain('aria-label="Läufe von Neustart nextcloud"');
  });

  it('a command task runs only with a code', () => {
    const out = html(
      <TaskRow
        task={task({ action: { kind: 'command', timeoutSec: 60, commandHash: '0a1b2c3d' } })}
        now={NOW}
        onEdit={noop}
        onRuns={noop}
      />,
    );
    expect(out).toContain('Befehl ausführen · #0a1b2c3d');
    expect(out).toContain('jetzt ausführen (mit Code)');
  });

  it('run detail shows exit code and output', () => {
    const r = task().lastRun;
    if (!r) throw new Error('fixture');
    const out = html(<RunDetail run={r} command />);
    expect(out).toContain('<dt>Exit-Code</dt><dd>1</dd>');
    expect(out).toContain('df: /mnt: No such file');
    expect(html(<RunDetail run={r} command={false} />)).not.toContain('Ausgabe');
  });
});

describe('task form', () => {
  it('lists the containers of the server, never hz.role, and locks command without --tasks', () => {
    const qc = new QueryClient();
    qc.setQueryData(containersKey, [
      container({ serverId: home.id, name: 'nextcloud', image: 'nextcloud:30' }),
      container({ serverId: home.id, name: 'hz-agent', protected: true }),
      container({ serverId: pi.id, name: 'pihole' }),
    ]);
    const out = html(<TaskForm servers={[home, pi]} commandServers={[pi.id]} onClose={noop} />, qc);
    expect(out).toContain('<option value="nextcloud">nextcloud · nextcloud:30</option>');
    expect(out).not.toContain('hz-agent');
    expect(out).not.toContain('pihole');
    expect(out).toMatch(
      /<option value="command" disabled="">Befehl ausführen · nur mit Agent --tasks/,
    );
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('Wochentage');
    expect(out).toContain('>Speichern<');
  });

  it('editing a command task warns and saves with a code', () => {
    const t = task({
      serverId: pi.id,
      serverName: 'pi',
      action: { kind: 'command', timeoutSec: 60, commandHash: '0a1b2c3d' },
      schedule: { type: 'interval', minutes: 30 },
    });
    const out = html(
      <TaskForm
        servers={[home, pi]}
        commandServers={[pi.id]}
        task={t}
        onClose={noop}
        onDelete={noop}
      />,
    );
    expect(out).toContain('Befehl läuft als Shell auf dem Host.');
    expect(out).toContain('Gespeichert als #0a1b2c3d');
    expect(out).toContain('Befehl anzeigen');
    expect(out).toContain('Mit Code speichern');
    expect(out).toContain('value="30"');
    expect(out).toContain('>Löschen<');
  });
});

const data: SelfhealResponse = {
  settings: defaultSelfhealSettings,
  rules: [
    {
      serverId: home.id,
      container: 'nextcloud',
      mode: 'unhealthy_or_exited',
      checkId: 'check-0000001',
      updatedAt: 0,
    },
  ],
  state: [
    {
      serverId: home.id,
      serverName: 'heimserver',
      container: 'nextcloud',
      phase: 'gave_up',
      attempts: 3,
      lastReason: 'check_down',
      lastRestartAt: new Date('2026-11-26T19:40:00Z').getTime(),
    },
  ],
  events: [
    {
      id: 1,
      at: new Date('2026-11-26T19:40:00Z').getTime(),
      serverId: home.id,
      serverName: 'heimserver',
      container: 'nextcloud',
      reason: 'check_down',
      action: 'gave_up',
      attempt: 3,
    },
  ],
};

describe('selfheal', () => {
  it('state row: aufgegeben with reset', () => {
    const s = data.state[0];
    if (!s) throw new Error('fixture');
    const out = html(<StateRow s={s} data={data} now={NOW} />);
    expect(out).toContain('heimserver · aufgegeben · Website DOWN · zuletzt 20:40');
    expect(out).toContain('title="3 von 3 Neustarts in 30 Min">3/3 Neustarts');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('Zurücksetzen');
    const watching = html(<StateRow s={{ ...s, phase: 'watching' }} data={data} now={NOW} />);
    expect(watching).not.toContain('Zurücksetzen');
  });

  it('rules: linked website check, no hz.role container to pick', () => {
    const out = html(
      <SelfhealRulesTile
        data={data}
        containers={[
          container({ serverId: home.id, serverName: 'heimserver', name: 'nextcloud' }),
          container({ serverId: home.id, serverName: 'heimserver', name: 'jellyfin' }),
          container({
            serverId: home.id,
            serverName: 'heimserver',
            name: 'hz-core',
            protected: true,
          }),
        ]}
        checks={[check({ id: 'check-0000001', def: { url: 'https://cloud.example.at' } })]}
      />,
    );
    expect(out).toContain('heimserver · Website');
    expect(out).toContain('Bei „unhealthy“ oder Absturz');
    expect(out).toContain('<option value="srv-home0001/jellyfin">heimserver · jellyfin</option>');
    expect(out).not.toContain('hz-core');
    expect(out).not.toContain('value="srv-home0001/nextcloud"');
  });

  it('events: newest first with time', () => {
    const out = html(<SelfhealEventsTile data={data} now={NOW} />);
    expect(out).toContain('heimserver · aufgegeben (Website DOWN)');
    expect(out).toContain('20:40');
  });
});

describe('module off', () => {
  it('a section of a switched-off module shows the note with the way back', () => {
    const out = html(<ModuleOff module="selfheal" title="Selbstheilung" />);
    expect(out).toContain('Modul ausgeschaltet. Selbstheilung ist in dieser Zentrale nicht aktiv.');
    expect(out).toContain('href="/settings#module"');
    const both = html(<ModuleOff module={['tasks', 'selfheal']} />);
    expect(both).toContain(
      'Geplante Aufgaben und Selbstheilung sind in dieser Zentrale nicht aktiv.',
    );
    expect(both).toContain('Automatik');
  });
});
