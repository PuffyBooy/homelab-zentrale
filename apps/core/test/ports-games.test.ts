import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ALLOWED_PORTS, portAlertKey, type ListeningPort } from '@hz/shared';
import { publicGamePorts } from '../src/games/service.js';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  stepUp,
  until,
  type WsClient,
} from './agent-helpers.js';
import { gameRequest, readyGame, withGames, type GameSetup } from './games-helpers.js';
import { completeSetup, makeApp, type TestApp } from './helpers.js';
import {
  archive,
  installExport,
  settled,
  startMigration,
  withTwoServers,
} from './migrate-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<GameSetup> {
  const s = await withGames(clients);
  t = s.t;
  return s;
}

const tcp = (port: number): ListeningPort => ({ proto: 'tcp', address: '0.0.0.0', port });

/** Inventory with these public ports from the fake agent of withGames. */
async function listening(s: GameSetup, ports: number[]): Promise<void> {
  s.agent.send(inventoryMsg({ listeningPorts: [tcp(22), ...ports.map(tcp)] }));
  await s.keepAlive();
}

const allowedOf = (s: GameSetup, serverId: string) => s.t.app.hzCore.ports.get(serverId).allowed;

const portAlert = (s: GameSetup, serverId: string, port: number) =>
  s.t.app.hzCore.alerts.active(portAlertKey(serverId, 'tcp', port));

describe('port audit: ports the hub opens for games are allowed', () => {
  it('create adds the game port with note game:<name>; PATCH moves it; delete removes it', async () => {
    const s = await setup();
    const g = await readyGame(s);
    expect(g.ports[0]?.port).toBe(25566);
    expect(allowedOf(s, s.serverId)).toContainEqual({
      port: 25566,
      proto: 'tcp',
      note: 'game:survival',
    });
    await listening(s, [25566]);
    expect(portAlert(s, s.serverId, 25566)).toBeNull();

    await stepUp(s.t, s.secret, s.cookie);
    const patch = await gameRequest(s, 'PATCH', `/api/games/${g.id}/ports`, {
      ports: { game: 25600 },
    });
    expect(patch.statusCode).toBe(200);
    const after = allowedOf(s, s.serverId);
    expect(after).toContainEqual({ port: 25600, proto: 'tcp', note: 'game:survival' });
    expect(after.some((p) => p.port === 25566)).toBe(false);
    await listening(s, [25600]);
    expect(portAlert(s, s.serverId, 25600)).toBeNull();

    await stepUp(s.t, s.secret, s.cookie);
    const del = await gameRequest(s, 'DELETE', `/api/games/${g.id}`, { confirmName: 'survival' });
    expect(del.statusCode).toBe(200);
    expect(allowedOf(s, s.serverId).some((p) => p.note === 'game:survival')).toBe(false);
    // Something still listening there after the delete is flagged again.
    await listening(s, [25600]);
    expect(portAlert(s, s.serverId, 25600)).not.toBeNull();
  });

  it('an entry the admin made stays as it is (note kept, not removed by the game)', async () => {
    const s = await setup();
    s.t.app.hzCore.ports.replace(s.serverId, [{ port: 25566, proto: 'tcp', note: 'mine' }]);
    const g = await readyGame(s);
    expect(allowedOf(s, s.serverId)).toEqual([{ port: 25566, proto: 'tcp', note: 'mine' }]);
    await stepUp(s.t, s.secret, s.cookie);
    await gameRequest(s, 'PATCH', `/api/games/${g.id}/ports`, { ports: { game: 25600 } });
    expect(allowedOf(s, s.serverId)).toEqual([
      { port: 25566, proto: 'tcp', note: 'mine' },
      { port: 25600, proto: 'tcp', note: 'game:survival' },
    ]);
  });

  it('a full list (MAX_ALLOWED_PORTS) skips the game port; the alert comes', async () => {
    const s = await setup();
    const full = Array.from({ length: MAX_ALLOWED_PORTS }, (_, i) => ({
      port: 30_000 + i,
      proto: 'tcp' as const,
    }));
    s.t.app.hzCore.ports.replace(s.serverId, full);
    const g = await readyGame(s);
    expect(g.ports[0]?.port).toBe(25566);
    const allowed = allowedOf(s, s.serverId);
    expect(allowed).toHaveLength(MAX_ALLOWED_PORTS);
    expect(allowed.some((p) => p.port === 25566)).toBe(false);
    await listening(s, [25566]);
    expect(portAlert(s, s.serverId, 25566)).not.toBeNull();
  });

  it('migration: the target gets the port, the source entry is removed when done', async () => {
    const m = await withTwoServers(clients);
    const { s } = m;
    t = s.t;
    await stepUp(s.t, s.secret, s.cookie);
    expect(allowedOf(s, s.serverId)).toContainEqual({
      port: 25566,
      proto: 'tcp',
      note: 'game:survival',
    });
    installExport(s, { data: archive(1000) });
    expect(
      (await startMigration(s, m.gameId, { targetServerId: m.target.serverId })).statusCode,
    ).toBe(202);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(allowedOf(s, m.target.serverId)).toContainEqual({
      port: 25567,
      proto: 'tcp',
      note: 'game:survival',
    });
    expect(allowedOf(s, s.serverId).some((p) => p.note === 'game:survival')).toBe(false);
    m.target.sendInventory([25566, 25567]);
    await until(() => s.t.app.hzCore.ports.get(m.target.serverId).open.length >= 3);
    expect(portAlert(s, m.target.serverId, 25567)).toBeNull();
  });

  it('a failed migration leaves the port lists unchanged', async () => {
    const m = await withTwoServers(clients, { refuse: { code: 'busy', message: 'exists' } });
    const { s } = m;
    t = s.t;
    await stepUp(s.t, s.secret, s.cookie);
    const before = allowedOf(s, m.target.serverId);
    installExport(s, { data: archive(1000) });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(allowedOf(s, m.target.serverId)).toEqual(before);
    expect(allowedOf(s, s.serverId)).toContainEqual({
      port: 25566,
      proto: 'tcp',
      note: 'game:survival',
    });
  });
});

describe('port audit: syncGame', () => {
  it('does not count as seeding; the first inventory still seeds without alerts', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const url = await listen(t);
    const e = await enrollAgent(t, url, cookie);
    clients.push(e.agent);
    const ports = t.app.hzCore.ports;
    ports.syncGame(e.serverId, 'survival', [{ port: 25565, proto: 'tcp' }]);
    expect(ports.seeded(e.serverId)).toBe(false);
    e.agent.send(inventoryMsg({ listeningPorts: [tcp(22), tcp(8080), tcp(25565)] }));
    await until(() => ports.seeded(e.serverId));
    expect(ports.get(e.serverId).allowed).toEqual([
      { port: 22, proto: 'tcp' },
      { port: 8080, proto: 'tcp' },
      { port: 25565, proto: 'tcp', note: 'game:survival' },
    ]);
    const tt = t;
    expect(
      tt.app.hzCore.alerts
        .list({ state: 'all', limit: 100 })
        .filter((a) => a.key.startsWith(`port:${e.serverId}:`)),
    ).toEqual([]);
  });

  it('publicGamePorts: ranges and tcp+udp expanded, local ports skipped', () => {
    expect(
      publicGamePorts([
        { name: 'game', port: 2456, protocol: 'udp', count: 3 },
        { name: 'both', port: 7777, protocol: 'tcp+udp', count: 1 },
        { name: 'web', port: 8211, protocol: 'tcp', count: 1, local: true },
      ]),
    ).toEqual([
      { port: 2456, proto: 'udp' },
      { port: 2457, proto: 'udp' },
      { port: 2458, proto: 'udp' },
      { port: 7777, proto: 'tcp' },
      { port: 7777, proto: 'udp' },
    ]);
  });
});
