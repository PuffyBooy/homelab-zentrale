import type { Task } from '@hz/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '../test-fixtures.js';
import { configureApi, isApiError } from './api.js';
import { setDisplayTimeZone } from './format.js';
import {
  actionText,
  createTask,
  defaultTaskName,
  draftToCreate,
  draftToUpdate,
  durationText,
  emptyTaskDraft,
  intervalText,
  lastRunText,
  needsStepUp,
  nextRunText,
  parseTimes,
  scheduleText,
  sortTasks,
  taskContainers,
  taskStatus,
  taskToDraft,
  tasksSentence,
} from './tasks.js';

const NOW = new Date('2026-11-26T20:00:00.000Z');
const at = (iso: string): number => new Date(iso).getTime();

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-00000001',
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    name: 'Neustart nextcloud',
    action: { kind: 'container.restart', container: 'nextcloud' },
    schedule: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['04:00'] },
    enabled: true,
    notifyOnFailure: true,
    createdAt: at('2026-11-20T10:00:00Z'),
    updatedAt: at('2026-11-20T10:00:00Z'),
    nextRunAt: at('2026-11-27T03:00:00Z'),
    lastRun: null,
    ...over,
  };
}

const run = (state: 'ok' | 'failed' | 'running' | 'skipped', summary = '') => ({
  id: 'run-1',
  taskId: 'task-00000001',
  trigger: 'schedule' as const,
  state,
  startedAt: at('2026-11-26T03:00:00Z'),
  finishedAt: at('2026-11-26T03:00:02Z'),
  durationMs: 2100,
  exitCode: null,
  summary,
  output: '',
});

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));
afterEach(() => vi.unstubAllGlobals());

describe('schedule texts', () => {
  it('reads weekly schedules in German', () => {
    expect(scheduleText({ type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['04:00'] })).toBe(
      'täglich um 04:00',
    );
    expect(scheduleText({ type: 'weekly', days: [5, 1, 2, 3, 4], times: ['18:00', '06:00'] })).toBe(
      'Mo–Fr um 06:00 und 18:00',
    );
    expect(scheduleText({ type: 'weekly', days: [6, 7], times: ['03:30', '12:00', '23:04'] })).toBe(
      'Sa, So um 03:30, 12:00 und 23:04',
    );
  });

  it('reads intervals in German', () => {
    expect(intervalText(5)).toBe('alle 5 Min');
    expect(intervalText(90)).toBe('alle 90 Min');
    expect(intervalText(60)).toBe('jede Stunde');
    expect(intervalText(360)).toBe('alle 6 Std');
    expect(intervalText(1440)).toBe('alle 24 Std');
    expect(intervalText(2880)).toBe('alle 2 Tage');
    expect(scheduleText({ type: 'interval', minutes: 30 })).toBe('alle 30 Min');
  });

  it('describes actions without the command text', () => {
    expect(actionText({ kind: 'container.restart', container: 'nextcloud' })).toBe(
      'Container neu starten · nextcloud',
    );
    expect(actionText({ kind: 'compose.update', dir: '/opt/homelab/apps/jellyfin' })).toBe(
      'Stack aktualisieren (pull + up) · /opt/homelab/apps/jellyfin',
    );
    expect(actionText({ kind: 'system.cleanup' })).toBe('Docker aufräumen');
    expect(actionText({ kind: 'command', timeoutSec: 300, commandHash: '1a2b3c4d' })).toBe(
      'Befehl ausführen · #1a2b3c4d',
    );
  });

  it('shows next and last run with status', () => {
    expect(nextRunText(task(), NOW)).toBe('nächster Lauf 27.11. 04:00');
    expect(nextRunText(task({ enabled: false }), NOW)).toBe('pausiert');
    expect(nextRunText(task({ nextRunAt: null }), NOW)).toBe('kein Lauf geplant');
    expect(lastRunText(null, NOW)).toBe('noch nie gelaufen');
    expect(lastRunText(run('ok', 'OK'), NOW)).toBe('zuletzt 04:00 · OK');
    expect(lastRunText(run('failed', 'Exit-Code 1'), NOW)).toBe('zuletzt 04:00 · Exit-Code 1');
    expect(lastRunText(run('running'), NOW)).toBe('läuft seit 04:00');
    expect(durationText(2100)).toBe('2,1 s');
    expect(durationText(42_000)).toBe('42 s');
    expect(durationText(184_000)).toBe('3 Min 4 s');
    expect(durationText(null)).toBe('—');
  });

  it('maps run states to shapes and puts failures first', () => {
    expect(taskStatus(task())).toBe('info');
    expect(taskStatus(task({ lastRun: run('ok') }))).toBe('ok');
    expect(taskStatus(task({ lastRun: run('failed') }))).toBe('crit');
    expect(taskStatus(task({ lastRun: run('skipped') }))).toBe('warn');
    expect(taskStatus(task({ enabled: false, lastRun: run('failed') }))).toBe('off');
    const bad = task({ id: 'task-00000002', name: 'Backup', lastRun: run('failed') });
    expect(sortTasks([task(), bad]).map((t) => t.name)).toEqual(['Backup', 'Neustart nextcloud']);
    expect(tasksSentence([task(), bad])).toEqual({
      em: 'Backup auf heimserver fehlgeschlagen',
      rest: ' · 2 von 2 Aufgaben aktiv',
    });
    expect(tasksSentence([task()])).toEqual({ em: null, rest: '1 von 1 Aufgabe aktiv.' });
    expect(tasksSentence([]).rest).toBe('Noch keine geplanten Aufgaben.');
  });
});

describe('task form', () => {
  it('builds a weekly container task with a default name', () => {
    const d = { ...emptyTaskDraft('srv-home0001'), container: 'nextcloud', times: '4:00, 18.30' };
    expect(defaultTaskName(d)).toBe('Neustart nextcloud');
    const res = draftToCreate(d);
    expect(res).toEqual({
      ok: true,
      body: {
        serverId: 'srv-home0001',
        name: 'Neustart nextcloud',
        action: { kind: 'container.restart', container: 'nextcloud' },
        schedule: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['04:00', '18:30'] },
        enabled: true,
        notifyOnFailure: true,
      },
    });
  });

  it('rejects bad input with German messages', () => {
    const res = draftToCreate({
      ...emptyTaskDraft(''),
      days: [],
      times: '25:00',
      name: 'x'.repeat(61),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.serverId).toBe('Server wählen.');
    expect(res.errors.container).toBe('Container wählen.');
    expect(res.errors.days).toBe('Mindestens einen Wochentag wählen.');
    expect(res.errors.times).toBe('Uhrzeiten wie 04:00, mehrere mit Komma.');
    expect(res.errors.name).toContain('Höchstens 60 Zeichen');
    expect(parseTimes('04:00 04:00')).toEqual(['04:00', '04:00']);
    const dup = draftToCreate({ ...emptyTaskDraft('s'), container: 'a', times: '04:00, 4:00' });
    expect(!dup.ok && dup.errors.times).toBe('Jede Uhrzeit nur einmal.');
  });

  it('checks interval, stack folder and command', () => {
    const base = { ...emptyTaskDraft('srv-home0001'), scheduleType: 'interval' as const };
    const short = draftToCreate({ ...base, kind: 'system.cleanup', minutes: '4' });
    expect(!short.ok && short.errors.minutes).toBe('5 bis 10080 Min');
    const ok = draftToCreate({ ...base, kind: 'system.cleanup', minutes: '30' }, 'heimserver');
    expect(ok.ok && ok.body.schedule).toEqual({ type: 'interval', minutes: 30 });
    expect(ok.ok && ok.body.name).toBe('Aufräumen heimserver');
    const dir = draftToCreate({ ...base, kind: 'compose.update', dir: '/etc/passwd' });
    expect(!dir.ok && dir.errors.dir).toContain('/opt/homelab/');
    const up = draftToCreate({ ...base, kind: 'compose.update', dir: '/opt/homelab/apps/jf/' });
    expect(up.ok && up.body.name).toBe('Update jf');
    const nl = draftToCreate({ ...base, kind: 'command', command: 'echo a\nrm -rf /' });
    expect(!nl.ok && nl.errors.command).toBe('Eine Zeile, höchstens 2000 Zeichen.');
    const cmd = draftToCreate({ ...base, kind: 'command', command: 'df -h /', timeoutSec: '60' });
    expect(cmd.ok && cmd.body.action).toEqual({
      kind: 'command',
      command: 'df -h /',
      timeoutSec: 60,
    });
  });

  it('edits a command task without sending the command again unless typed', () => {
    const saved = task({
      action: { kind: 'command', timeoutSec: 120, commandHash: 'abcdef01' },
      schedule: { type: 'interval', minutes: 15 },
    });
    const d = taskToDraft(saved);
    expect(d.command).toBe('');
    expect(d.timeoutSec).toBe('120');
    expect(d.scheduleType).toBe('interval');
    const keep = draftToUpdate(d, saved);
    expect(keep.ok && 'action' in keep.body).toBe(false);
    const changed = draftToUpdate({ ...d, command: 'uptime' }, saved);
    expect(changed.ok && changed.body.action).toEqual({
      kind: 'command',
      command: 'uptime',
      timeoutSec: 120,
    });
    expect(needsStepUp(d, saved)).toBe(true);
    // Turning a container task into a command task needs the command.
    const plain = task();
    const toCmd = draftToUpdate({ ...taskToDraft(plain), kind: 'command' }, plain);
    expect(!toCmd.ok && toCmd.errors.command).toBe('Eine Zeile, höchstens 2000 Zeichen.');
    expect(needsStepUp(taskToDraft(plain), plain)).toBe(false);
  });

  it('offers only unprotected containers of the server', () => {
    const list = [
      container({ serverId: 'srv-a', name: 'web' }),
      container({ serverId: 'srv-a', name: 'hz-agent', protected: true }),
      container({ serverId: 'srv-b', name: 'db' }),
    ];
    expect(taskContainers(list, 'srv-a').map((c) => c.name)).toEqual(['web']);
  });
});

describe('step-up', () => {
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('a command task asks for the code and repeats the create once', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    const reset = configureApi({ onStepUp });
    const created = task({ action: { kind: 'command', timeoutSec: 300, commandHash: '0a0b0c0d' } });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(403, { ok: false, error: 'step_up_required' }))
      .mockResolvedValueOnce(reply(201, created));
    vi.stubGlobal('fetch', fetchMock);
    const body = {
      serverId: 'srv-home0001',
      name: 'Platte',
      action: { kind: 'command' as const, command: 'df -h /', timeoutSec: 300 },
      schedule: { type: 'interval' as const, minutes: 60 },
    };
    try {
      await expect(createTask(body)).resolves.toEqual(created);
    } finally {
      reset();
    }
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tasks');
  });

  it('a cancelled code sends nothing again', async () => {
    const reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(403, { ok: false, error: 'step_up_required' }));
    vi.stubGlobal('fetch', fetchMock);
    let err: unknown;
    try {
      await createTask({
        serverId: 'srv-home0001',
        name: 'x',
        action: { kind: 'command', command: 'uptime', timeoutSec: 300 },
        schedule: { type: 'interval', minutes: 60 },
      });
    } catch (e) {
      err = e;
    } finally {
      reset();
    }
    expect(isApiError(err, 'step_up_required')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
