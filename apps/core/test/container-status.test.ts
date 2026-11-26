import { describe, expect, it } from 'vitest';
import type { ContainerHealth, ContainerState, ContainerStatus } from '@hz/shared';
import {
  alertClass,
  containerStatus,
  containerStatusText,
  type AlertClass,
  type ContainerIntent,
} from '../src/containers/status.js';

type Row = [
  ContainerState,
  ContainerHealth,
  number | null,
  ContainerIntent | null,
  ContainerStatus,
];

const table: Row[] = [
  ['running', 'none', null, null, 'ok'],
  ['running', 'healthy', null, null, 'ok'],
  ['running', 'starting', null, null, 'busy'],
  ['running', 'unhealthy', null, null, 'crit'],
  ['restarting', 'none', 1, null, 'warn'],
  ['paused', 'none', null, null, 'warn'],
  ['removing', 'none', null, null, 'busy'],
  ['created', 'none', 0, null, 'off'],
  ['exited', 'none', 0, null, 'off'],
  ['exited', 'none', null, null, 'off'],
  ['exited', 'none', 1, null, 'crit'],
  ['exited', 'none', 137, null, 'crit'],
  ['exited', 'none', 143, 'stop', 'off'],
  ['exited', 'none', 1, 'restart', 'off'],
  ['dead', 'none', null, null, 'crit'],
  ['dead', 'none', 0, null, 'crit'],
];

describe('container status mapping', () => {
  it.each(table)('%s/%s exit %s intent %s -> %s', (state, health, exitCode, intent, status) => {
    expect(containerStatus({ state, health, exitCode, intent })).toBe(status);
  });

  it('every state has a German status text with the exit code', () => {
    expect(
      containerStatusText({ state: 'exited', health: 'none', exitCode: 1, intent: null }),
    ).toBe('beendet (Exit-Code 1)');
    expect(
      containerStatusText({ state: 'exited', health: 'none', exitCode: 143, intent: 'stop' }),
    ).toBe('gestoppt (Exit-Code 143)');
    expect(
      containerStatusText({ state: 'running', health: 'none', exitCode: null, intent: null }),
    ).toBe('läuft');
  });
});

type AlertRow = [
  ContainerState,
  ContainerHealth,
  number | null,
  ContainerIntent | null,
  boolean,
  AlertClass,
];

const alertTable: AlertRow[] = [
  ['running', 'healthy', null, null, false, 'up'],
  ['running', 'starting', null, null, false, 'up'],
  ['running', 'unhealthy', null, null, false, 'down'],
  ['exited', 'none', 1, null, false, 'down'],
  ['exited', 'none', 0, null, false, 'stopped'],
  ['exited', 'none', 0, null, true, 'down'],
  ['exited', 'none', 137, 'stop', false, 'stopped'],
  ['exited', 'none', 137, 'stop', true, 'stopped'],
  ['exited', 'none', 1, 'restart', false, 'none'],
  ['dead', 'none', null, null, false, 'down'],
  ['restarting', 'none', 1, null, false, 'none'],
  ['created', 'none', null, null, false, 'none'],
  ['paused', 'none', null, null, false, 'none'],
];

describe('container alert class', () => {
  it.each(alertTable)(
    '%s/%s exit %s intent %s oom %s -> %s',
    (state, health, exitCode, intent, oom, cls) => {
      expect(alertClass({ state, health, exitCode, intent, oom })).toBe(cls);
    },
  );
});
