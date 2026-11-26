import { describe, expect, it } from 'vitest';
import { container } from '../test-fixtures.js';
import {
  containerMeta,
  containerSentence,
  containerSub,
  formatPorts,
  groupContainers,
  runningCount,
  sortContainers,
  worstStatus,
} from './containers.js';

const NOW = new Date('2026-11-25T22:04:00.000Z');

describe('sortContainers', () => {
  it('puts problems first, stopped last, then by name', () => {
    const list = [
      container({ name: 'uptime-kuma', status: 'off', state: 'exited', exitCode: 0 }),
      container({ name: 'homeassistant' }),
      container({ name: 'lernplattform', status: 'crit', state: 'exited', exitCode: 1 }),
      container({ name: 'minecraft', status: 'warn', state: 'restarting' }),
      container({ name: 'caddy' }),
    ];
    expect(sortContainers(list).map((c) => c.name)).toEqual([
      'lernplattform',
      'minecraft',
      'caddy',
      'homeassistant',
      'uptime-kuma',
    ]);
    expect(list[0]?.name).toBe('uptime-kuma');
  });
});

describe('worstStatus', () => {
  it('ignores stopped containers', () => {
    expect(worstStatus([])).toBe('ok');
    expect(worstStatus([container({ status: 'off' })])).toBe('ok');
    expect(worstStatus([container({ status: 'warn' }), container({ status: 'crit' })])).toBe(
      'crit',
    );
  });
});

describe('groupContainers', () => {
  const pi = { serverId: 'srv-pi000001', serverName: 'soundos-pi' };
  const home = { serverId: 'srv-home0001', serverName: 'heimserver' };
  const oci = { serverId: 'srv-oci00001', serverName: 'oracle-a1' };

  it('groups by server, then compose project; problems first', () => {
    const groups = groupContainers([
      container({ ...pi, name: 'soundos' }),
      container({ ...home, name: 'homeassistant' }),
      container({ ...home, name: 'jellyfin', composeProject: 'media' }),
      container({ ...home, name: 'sonarr', composeProject: 'media' }),
      container({ ...home, name: 'grafana', composeProject: 'monitoring' }),
      container({
        ...home,
        name: 'prometheus',
        composeProject: 'monitoring',
        status: 'crit',
        state: 'exited',
        exitCode: 137,
      }),
      container({ ...oci, name: 'minecraft', status: 'warn', state: 'restarting' }),
    ]);
    expect(groups.map((g) => g.serverName)).toEqual(['heimserver', 'oracle-a1', 'soundos-pi']);
    const h = groups[0];
    expect(h?.status).toBe('crit');
    expect(h?.problems).toBe(1);
    expect(h?.running).toBe(4);
    expect(h?.total).toBe(5);
    // Project with the problem first, then projects by name, standalone last.
    expect(h?.projects.map((p) => p.project)).toEqual(['monitoring', 'media', null]);
    expect(h?.projects[0]?.containers.map((c) => c.name)).toEqual(['prometheus', 'grafana']);
    expect(h?.projects[0]?.key).toBe('srv-home0001/monitoring');
  });

  it('keeps servers apart that share a name', () => {
    const groups = groupContainers([
      container({ serverId: 'srv-a0000001', serverName: 'x' }),
      container({ serverId: 'srv-b0000001', serverName: 'x' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('formatPorts', () => {
  it('shows published ports once, local binds with address', () => {
    expect(
      formatPorts([
        { privatePort: 8123, publicPort: 8123, ip: '0.0.0.0', proto: 'tcp' },
        { privatePort: 8123, publicPort: 8123, ip: '::', proto: 'tcp' },
        { privatePort: 19132, publicPort: 19132, proto: 'udp' },
        { privatePort: 3000, publicPort: 3001, ip: '127.0.0.1', proto: 'tcp' },
        { privatePort: 9000, proto: 'tcp' },
      ]),
    ).toBe('127.0.0.1:3001, :8123, :19132/udp');
    expect(formatPorts([])).toBe('');
  });

  it('builds the second line', () => {
    const c = container({
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      ports: [{ privatePort: 8123, publicPort: 8123, proto: 'tcp' }],
    });
    expect(containerSub(c)).toBe('ghcr.io/home-assistant/home-assistant:stable · :8123');
    expect(containerSub(c, true)).toBe('heimserver · :8123');
  });
});

describe('containerMeta', () => {
  it('shows exit code when stopped', () => {
    expect(containerMeta(container({ state: 'exited', exitCode: 1 }), NOW)).toBe('exit 1');
    expect(containerMeta(container({ state: 'exited', exitCode: null }), NOW)).toBe('gestoppt');
  });

  it('shows CPU, RAM and uptime when running, in Austrian format', () => {
    expect(containerMeta(container({ cpu: 1.24, memBytes: 312 * 1024 ** 2 }), NOW)).toBe(
      'CPU 1,2 % · RAM 312 MB · 3 h',
    );
    expect(containerMeta(container({ cpu: 1.24 }), NOW, false)).toBe('3 h');
    expect(containerMeta(container({ health: 'unhealthy', cpu: null, memBytes: null }), NOW)).toBe(
      'unhealthy · 3 h',
    );
  });
});

describe('sentences', () => {
  it('counts running containers', () => {
    expect(runningCount([container(), container({ state: 'exited' })])).toBe('1 von 2 läuft');
    expect(runningCount([container(), container()])).toBe('2 von 2 laufen');
  });

  it('names a single problem, counts several', () => {
    expect(containerSentence([])).toEqual({ em: null, rest: 'Keine Container gemeldet.' });
    expect(containerSentence([container(), container()])).toEqual({
      em: null,
      rest: '2 von 2 Containern laufen',
    });
    const bad = container({ name: 'lernplattform', status: 'crit', state: 'exited' });
    expect(containerSentence([container(), bad])).toEqual({
      em: 'lernplattform auf heimserver ist ausgefallen',
      rest: ' · 1 von 2 Containern läuft',
    });
    expect(containerSentence([bad, container({ status: 'warn' })]).em).toBe('2 Probleme');
  });
});
