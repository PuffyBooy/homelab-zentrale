import type {
  DockerDfResponse,
  DuResponse,
  HistoryResponse,
  ProcessesResponse,
  ServiceUnitInfo,
  ServicesResponse,
} from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureApi, isApiError } from '../../lib/api.js';
import { setDisplayTimeZone } from '../../lib/format.js';
import {
  duAllowed,
  duBlocked,
  fetchDu,
  fetchProcesses,
  filterUnits,
  joinPath,
  pathCrumbs,
  runCleanupItems,
  selectedBytes,
  selectedKinds,
  serviceAction,
  seriesStats,
  shutdownServer,
  sortUnits,
  statsText,
  unitOps,
  unitStatus,
} from '../../lib/serverAdmin.js';
import { detail, server } from '../../test-fixtures.js';
import { CleanupChoice } from './CleanupDialog.js';
import { DockerDfView } from './DockerDfTile.js';
import { DuView } from './DuTile.js';
import { HistoryView } from './HistoryTile.js';
import { ProcessesView } from './ProcessesTile.js';
import { SERVER_SECTIONS, ServerSectionNav } from './ServerSectionNav.js';
import { ServicesView, UnitRow } from './ServicesTile.js';
import { ShutdownBody } from './ShutdownDialog.js';

const GB = 1024 ** 3;
const noop = (): void => undefined;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let reset: (() => void) | undefined;
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});
beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

function stub(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('Verlauf', () => {
  const s = server({ name: 'heimserver', cpu: 23, ramPct: 48, temp: 44, diskPct: 81 });
  const d = { ...detail(s), net: { rxBps: 1.2 * 1024 * 1024, txBps: 340 * 1024 } };
  const points: HistoryResponse['points'] = [10, 20, 30, 40].map((cpu, i) => ({
    ts: new Date(Date.UTC(2026, 10, 26, 21, i)).toISOString(),
    cpu,
    ramPct: 50,
    netIn: 1000,
    netOut: 500,
    temp: 40 + i,
    diskMax: 80 + i,
  }));

  it('range switch with four pressed-state buttons, six rows with Min, Ø and Max', () => {
    const out = html(
      <HistoryView detail={d} range="7d" onRange={noop} history={{ range: '7d', points }} />,
    );
    expect(out).toContain('aria-label="Zeitraum"');
    for (const label of ['1 h', '24 h', '7 Tage', '30 Tage']) expect(out).toContain(`>${label}<`);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*><span>7 Tage/);
    for (const r of ['CPU', 'RAM', 'Netz ein', 'Netz aus', 'Temperatur', 'Disk']) {
      expect(out).toContain(`>${r}<`);
    }
    expect(out).toContain('Min 10 % · Ø 25 % · Max 40 %');
    expect(out).toContain('Min 40 °C · Ø 41,5 °C · Max 43 °C');
    expect(out).toContain('Min 80 % · Ø 82 % · Max 83 %');
    expect(out).toContain('1,2 MB/s');
    expect(out).toContain('hz-spark');
  });

  it('without temperature or disk data those rows disappear', () => {
    const plain = points.map((p) => ({ ...p, temp: null, diskMax: null }));
    const s2 = { ...d, server: { ...s, temp: null, diskPct: null } };
    const out = html(
      <HistoryView
        detail={s2}
        range="1h"
        onRange={noop}
        history={{ range: '1h', points: plain }}
      />,
    );
    expect(out).not.toContain('>Temperatur<');
    expect(out).not.toContain('>Disk<');
  });

  it('stats skip null values', () => {
    expect(seriesStats([null, 2, undefined, 4])).toEqual({ min: 2, avg: 3, max: 4 });
    expect(statsText(seriesStats([]), String)).toBe('keine Werte');
  });
});

describe('Größte Ordner', () => {
  const data: DuResponse = {
    path: '/var',
    totalBytes: 100 * GB,
    truncated: true,
    entries: [
      { name: 'lib', bytes: 80 * GB, dir: true },
      { name: 'log', bytes: 15 * GB, dir: true },
      { name: 'swap.img', bytes: 5 * GB, dir: false },
    ],
  };
  const view = (over: Partial<Parameters<typeof DuView>[0]> = {}) =>
    html(
      <DuView
        path="/var"
        started
        offline={false}
        loading={false}
        data={data}
        error={null}
        onStart={noop}
        onOpen={noop}
        onRetry={noop}
        {...over}
      />,
    );

  it('folders open deeper, files do not; sizes relative to the total', () => {
    const out = view();
    expect(out).toContain('aria-label="/var/lib öffnen"');
    expect(out).toContain('aria-label="/var/log öffnen"');
    expect(out).not.toContain('swap.img öffnen');
    expect(out).toContain('80 GB · 80 %');
    expect(out).toContain('Die Größen sind Untergrenzen.');
    // Breadcrumb back to /
    expect(out).toContain('aria-label="Zurück zu /"');
    expect(out).toContain('aria-current="location"');
  });

  it('starts at / only on request; loading says it can take a minute', () => {
    const idle = view({ path: '/', started: false, data: undefined });
    expect(idle).toContain('Ab / messen');
    const busy = view({ loading: true, data: undefined });
    expect(busy).toContain('Misst /var …');
    expect(busy).toContain('hz-status-busy');
    expect(busy).toContain('bis zu 1 Min');
  });

  it('errors are German and offer a retry', () => {
    const out = view({ data: undefined, error: 'Nur eine Messung alle 5 s.' });
    expect(out).toContain('Nur eine Messung alle 5 s.');
    expect(out).toContain('Erneut messen');
  });

  it('a folder whose path would exceed 256 characters cannot be opened, with a hint', () => {
    const parent = `/${'a'.repeat(200)}`;
    const long = 'b'.repeat(60);
    const out = view({
      path: parent,
      data: {
        path: parent,
        totalBytes: 2 * GB,
        truncated: false,
        entries: [
          { name: long, bytes: GB, dir: true },
          { name: 'ok', bytes: GB, dir: true },
        ],
      },
    });
    expect(out).not.toContain(`${long} öffnen`);
    expect(out).toContain(`aria-label="${parent}/ok öffnen"`);
    expect(out).toContain('Pfad länger als 256 Zeichen.');
    expect(duBlocked(`${parent}/${long}`)).toBe('too_long');
    expect(duBlocked('/var/lib')).toBeNull();
    expect(duBlocked('/proc/1')).toBe('denied');
    expect(duBlocked('/var/a\u0007b')).toBe('invalid');
  });

  it('paths: join, crumbs and the denied roots', () => {
    expect(joinPath('/', 'var')).toBe('/var');
    expect(joinPath('/var', 'lib')).toBe('/var/lib');
    expect(pathCrumbs('/var/lib').map((c) => c.path)).toEqual(['/', '/var', '/var/lib']);
    expect(duAllowed('/proc')).toBe(false);
    expect(duAllowed('/run/user')).toBe(false);
    expect(duAllowed('/running')).toBe(true);
  });

  it('fetchDu encodes the path', async () => {
    const f = stub(reply(200, data));
    await fetchDu('srv-000001', '/var/lib docker');
    expect(f.mock.calls[0]?.[0]).toBe('/api/servers/srv-000001/du?path=%2Fvar%2Flib%20docker');
  });
});

describe('Docker-Belegung', () => {
  const df: DockerDfResponse = {
    images: { count: 14, bytes: 12 * GB, unusedCount: 3, unusedBytes: 3.4 * GB },
    containers: { count: 5, bytes: 1 * GB, running: 4 },
    volumes: { count: 6, bytes: 20 * GB, unusedCount: 1, unusedBytes: 2 * GB },
    buildCache: { count: 40, bytes: 4 * GB, unusedBytes: 4 * GB },
  };
  it('images, containers, volumes and build cache with the unused part', () => {
    const out = html(
      <DockerDfView data={df} offline={false} loading={false} error={null} onRefresh={noop} />,
    );
    for (const t of ['Images', 'Container', 'Volumes', 'Build-Cache']) expect(out).toContain(t);
    expect(out).toContain('14 · 3 ungenutzt');
    expect(out).toContain('5 · 4 laufen');
    expect(out).toContain('3,4 GB');
    expect(out).toContain('37 GB');
    expect(out).toContain('9,4 GB');
    expect(out).toContain('Container und Volumes bleiben.');
  });
});

describe('Aufräumen mit Auswahl', () => {
  const preview = {
    items: [
      { kind: 'apt-cache' as const, bytes: 1 * GB },
      { kind: 'docker-images' as const, bytes: 6 * GB, detail: '7 Images' },
      { kind: 'docker-build-cache' as const, bytes: 2 * GB },
    ],
    totalBytes: 9 * GB,
  };

  it('one switch per item, the sum follows the selection', () => {
    const all = new Set(preview.items.map((i) => i.kind));
    const out = html(<CleanupChoice data={preview} selected={all} onToggle={noop} />);
    expect(out.match(/role="switch"/g)).toHaveLength(3);
    expect(out.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(out).toContain('Docker-Build-Cache');
    expect(out).toContain('7 Images');
    expect(out).toContain('9 GB');

    const only = new Set(['docker-build-cache'] as const);
    const one = html(<CleanupChoice data={preview} selected={only} onToggle={noop} />);
    expect(one.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(selectedBytes(preview.items, only)).toBe(2 * GB);
    expect(selectedKinds(preview.items, only)).toEqual(['docker-build-cache']);
    expect(selectedKinds(preview.items, new Set())).toEqual([]);
  });

  it('posts only the chosen items', async () => {
    const f = stub(reply(200, { freedBytes: 2 * GB }));
    await runCleanupItems('srv-000001', ['docker-build-cache']);
    expect(f.mock.calls[0]?.[0]).toBe('/api/servers/srv-000001/cleanup');
    expect(f.mock.calls[0]?.[1]?.body).toBe('{"items":["docker-build-cache"]}');
  });
});

const unit = (over: Partial<ServiceUnitInfo>): ServiceUnitInfo => ({
  name: 'x.service',
  description: '',
  load: 'loaded',
  active: 'active',
  sub: 'running',
  manageable: false,
  ...over,
});

describe('Dienste', () => {
  const units: ServiceUnitInfo[] = [
    unit({ name: 'nginx.service', description: 'nginx', manageable: true }),
    unit({ name: 'backup.service', active: 'failed', sub: 'failed', description: 'Backup' }),
    unit({ name: 'cron.service', description: 'cron' }),
    unit({ name: 'old.service', active: 'inactive', sub: 'dead', manageable: true }),
  ];
  const data: ServicesResponse = { systemd: true, units };
  const view = (over: Partial<Parameters<typeof ServicesView>[0]> = {}) =>
    html(
      <ServicesView
        serverName="heimserver"
        failed={[]}
        offline={false}
        data={data}
        loading={false}
        error={null}
        view="running"
        query=""
        onView={noop}
        onQuery={noop}
        onRefresh={noop}
        onAction={noop}
        busyUnit={null}
        done={null}
        actionError={null}
        {...over}
      />,
    );

  it('failed first with shape and text, actions only for manageable units', () => {
    const out = view();
    expect(out.indexOf('backup.service')).toBeLessThan(out.indexOf('nginx.service'));
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('1 fehlgeschlagen');
    expect(out).toContain('aria-label="nginx.service neu starten"');
    expect(out).toContain('aria-label="nginx.service stoppen"');
    expect(out).not.toContain('aria-label="cron.service');
    expect(out).not.toContain('aria-label="backup.service');
    // "Nur laufende" hides the inactive unit.
    expect(out).not.toContain('old.service');
    expect(out).toContain('HZ_AGENT_SERVICES');
  });

  it('"Alle" shows inactive units with Starten', () => {
    const out = view({ view: 'all' });
    expect(out).toContain('aria-label="old.service starten"');
    expect(out).toContain('hz-status-off');
  });

  it('failedServices from the detail show before the list is loaded', () => {
    const out = view({ data: undefined, loading: true, failed: ['backup.service'] });
    expect(out).toContain('backup.service');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('Lade Dienste …');
    expect(out).toContain('1 fehlgeschlagen');
  });

  it('a non-manageable unit renders no action buttons at all', () => {
    const out = html(
      <UnitRow
        u={unit({ name: 'sshd.service', manageable: false })}
        busy={false}
        onAction={noop}
      />,
    );
    expect(out).not.toContain('<button');
    expect(unitOps(unit({ manageable: false, active: 'failed' }))).toEqual([]);
    expect(unitOps(unit({ manageable: true, active: 'failed' }))).toEqual(['start']);
  });

  it('filter, sort and status', () => {
    expect(sortUnits(units).map((u) => u.name)[0]).toBe('backup.service');
    expect(filterUnits(units, 'running', 'ngi').map((u) => u.name)).toEqual(['nginx.service']);
    expect(filterUnits(units, 'running', 'BACKUP').map((u) => u.name)).toEqual(['backup.service']);
    expect(unitStatus({ active: 'activating' })).toBe('busy');
  });

  it('no systemd: says so', () => {
    expect(view({ data: { systemd: false, units: [] } })).toContain('hat kein systemd');
  });

  it('posts unit and op', async () => {
    const f = stub(reply(200, { ok: true }));
    await serviceAction('srv-000001', 'nginx.service', 'restart');
    expect(f.mock.calls[0]?.[1]?.body).toBe('{"unit":"nginx.service","op":"restart"}');
  });
});

describe('Prozesse', () => {
  const data: ProcessesResponse = {
    total: 212,
    list: [
      {
        pid: 1234,
        name: 'java',
        user: 'mc',
        cpu: 42.5,
        memBytes: 3.2 * GB,
        memPct: 20,
        state: 'S',
        container: 'mc-survival',
      },
      { pid: 88, name: 'node', user: 'root', cpu: 3, memBytes: 0.5 * GB, memPct: 3, state: 'S' },
    ],
  };
  it('table with PID, Name, Benutzer, CPU, RAM, Container and a sort switch', () => {
    const out = html(
      <ProcessesView
        sort="mem"
        onSort={noop}
        data={data}
        offline={false}
        loading={false}
        error={null}
        updatedAt={new Date('2026-11-26T22:04:00.000Z')}
        onRefresh={noop}
      />,
    );
    for (const h of ['PID', 'Name', 'Benutzer', 'CPU', 'RAM', 'Container']) {
      expect(out).toContain(`>${h}<`);
    }
    expect(out).toContain('aria-label="Prozesse nach RAM"');
    expect(out).toContain('aria-sort="descending"');
    expect(out).toContain('42,5 %');
    expect(out).toContain('3,2 GB');
    expect(out).toContain('mc-survival');
    expect(out).toContain('212 Prozesse gesamt · Stand 23:04');
    expect(out).toContain('aria-label="Prozesse neu laden"');
  });

  it('asks the core with the sort', async () => {
    const f = stub(reply(200, data));
    await fetchProcesses('srv-000001', 'mem');
    expect(f.mock.calls[0]?.[0]).toBe('/api/servers/srv-000001/processes?sort=mem');
  });
});

describe('Herunterfahren', () => {
  it('dialog: danger button, disabled until the name is typed, says it stays off', () => {
    const out = html(<ShutdownBody open serverId="srv-000001" serverName="pi" onClose={noop} />);
    expect(out).toContain('bleibt danach aus, bis ihn jemand einschaltet oder per Wake-on-LAN');
    expect(out).toContain('Servername');
    expect(out).toMatch(
      /<button disabled="" class="hz-btn hz-btn-danger[^"]*" type="submit">.*Herunterfahren/,
    );
  });

  it('step-up: the code dialog appears and the request repeats', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const f = stub(reply(403, { ok: false, error: 'step_up_required' }), reply(200, { ok: true }));
    await shutdownServer('srv-000001', 'pi');
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1]?.[0]).toBe('/api/servers/srv-000001/shutdown');
    expect(f.mock.calls[1]?.[1]?.body).toBe('{"confirmName":"pi"}');
  });

  it('cancelled step-up rejects with step_up_required', async () => {
    reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    stub(reply(403, { ok: false, error: 'step_up_required' }));
    const err = await shutdownServer('srv-000001', 'pi').catch((e: unknown) => e);
    expect(isApiError(err, 'step_up_required')).toBe(true);
  });
});

describe('section nav', () => {
  it('plain anchors for every section', () => {
    const out = html(<ServerSectionNav />);
    expect(out).toContain('aria-label="Bereiche des Servers"');
    for (const s of SERVER_SECTIONS) expect(out).toContain(`href="#${s.id}"`);
  });
});
