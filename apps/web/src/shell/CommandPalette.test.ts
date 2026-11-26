import type { HaItem, HaState } from '@hz/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onErrorToast, type LocalToast } from './AlertToasts.js';
import { container, game, repo, server, target } from '../test-fixtures.js';
import {
  containerCommands,
  filterCommands,
  gameCommands,
  haCommands,
  paletteCommands,
  repoCommands,
  serverCommands,
  staticActions,
  withoutGames,
} from './CommandPalette.js';

const qc = new QueryClient();

describe('command palette', () => {
  it('lists pages with their shortcut', () => {
    expect(paletteCommands.map((c) => c.label)).toContain('Konsole');
    expect(paletteCommands.find((c) => c.id === 'console')?.hint).toBe('`');
  });

  it('offers "Konsole <server>" only where the console is usable', () => {
    const cmds = serverCommands([
      server({ id: 'srv-aaaaaaaa', name: 'heimserver', allowTerminal: true }),
      server({ id: 'srv-bbbbbbbb', name: 'pi', allowTerminal: false }),
      server({ id: 'srv-cccccccc', name: 'oracle-a1', allowTerminal: true, connected: false }),
    ]);
    expect(cmds.filter((c) => c.label.startsWith('Konsole')).map((c) => c.to)).toEqual([
      '/console?server=srv-aaaaaaaa',
    ]);
    expect(cmds.find((c) => c.label === 'pi')?.to).toBe('/servers/srv-bbbbbbbb');
  });

  it('asks before restarting a container, game stop or a deploy', () => {
    const c = containerCommands(qc, [container({ name: 'homeassistant' })]);
    expect(c.find((x) => x.label === 'homeassistant neu starten')?.confirm?.action).toBe(
      'Neu starten',
    );
    const running = gameCommands(qc, [game({ name: 'minecraft', status: 'ok' })]);
    expect(running.map((x) => [x.label, !!x.confirm])).toEqual([
      ['minecraft', false],
      ['minecraft neu starten', true],
      ['minecraft stoppen', true],
    ]);
    const stopped = gameCommands(qc, [game({ name: 'valheim', status: 'off' })]);
    expect(stopped.map((x) => [x.label, !!x.confirm])).toEqual([
      ['valheim', false],
      ['valheim starten', false],
    ]);
    const r = repoCommands(qc, [
      repo({
        fullName: 'PuffyBooy/my-app',
        targets: [target({ headSha: 'a'.repeat(40), serverName: 'pi', behind: 3 })],
      }),
    ]);
    const deploy = r.find((x) => x.label === 'my-app deployen');
    expect(deploy?.confirm?.title).toBe('my-app auf pi deployen?');
    expect(deploy?.confirm?.text).toContain('aaaaaaa');
  });

  it('lists game containers only as games', () => {
    const g = game({ name: 'survival', serverId: 'srv-home0001' });
    const list = withoutGames(
      [container({ name: 'game-survival' }), container({ name: 'nginx' })],
      [g],
    );
    expect(list.map((c) => c.name)).toEqual(['nginx']);
  });

  it('matches all words in label and hint', () => {
    const cmds = [
      ...staticActions,
      ...containerCommands(qc, [container({ name: 'minecraft-proxy', serverName: 'oracle-a1' })]),
    ];
    expect(filterCommands(cmds, 'minecraft neu').map((c) => c.label)).toEqual([
      'minecraft-proxy neu starten',
    ]);
    expect(filterCommands(cmds, 'wand').map((c) => c.label)).toEqual(['Wandmodus öffnen']);
  });
});

const item: HaItem = {
  entityId: 'light.wohnzimmer',
  kind: 'toggle',
  roomId: null,
  label: 'Licht Wohnzimmer',
  overview: true,
  state: 'off',
  value: null,
  unit: null,
  deviceClass: null,
  available: true,
  lastChanged: null,
  pending: false,
};
const state: HaState = {
  status: 'connected',
  error: null,
  rooms: [],
  items: [item],
  energy: null,
  updatedAt: '2026-11-26T22:04:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('palette HA commands', () => {
  it('a failed switch shows a short error toast instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error: 'ha_error',
              message: 'Home Assistant nicht erreichbar',
            }),
            { status: 502 },
          ),
        ),
      ),
    );
    const toasts: LocalToast[] = [];
    const off = onErrorToast((t) => toasts.push(t));
    try {
      const [cmd] = haCommands(new QueryClient(), state);
      expect(cmd?.label).toBe('Licht Wohnzimmer einschalten');
      cmd?.run?.();
      await vi.waitFor(() => expect(toasts).toHaveLength(1));
      expect(toasts[0]).toMatchObject({
        title: 'Licht Wohnzimmer nicht geschaltet',
        body: 'Home Assistant nicht erreichbar',
      });
    } finally {
      off();
    }
  });
});
