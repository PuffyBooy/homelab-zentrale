import { afterEach, describe, expect, it } from 'vitest';
import { gamePortsUpdateResponseSchema } from '@hz/shared';
import { auditLog, gameServers } from '../src/db/schema.js';
import { forwardingHint } from '../src/games/service.js';
import { stepUp, type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';

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

const patchPorts = (s: GameSetup, id: string, payload: Record<string, unknown>) =>
  gameRequest(s, 'PATCH', `/api/games/${id}/ports`, payload);

describe('PATCH /api/games/:id/ports', () => {
  it('rewrites compose, recreates a running game and returns the forwarding hint', async () => {
    const s = await setup();
    const g = await readyGame(s);
    expect(g.ports).toEqual([{ name: 'game', port: 25566, protocol: 'tcp' }]);
    await stepUp(s.t, s.secret, s.cookie);
    const writes = rpcsOf(s, 'compose.write').length;
    const ups = rpcsOf(s, 'compose.up').length;
    const res = await patchPorts(s, g.id, { ports: { game: 25600 } });
    expect(res.statusCode).toBe(200);
    const body = gamePortsUpdateResponseSchema.parse(res.json());
    expect(body.changed).toEqual([
      { name: 'game', protocol: 'tcp', count: 1, from: 25566, to: 25600, local: false },
    ]);
    expect(body.ports).toEqual([
      { name: 'game', port: 25600, protocol: 'tcp', count: 1, local: false },
    ]);
    expect(body.forwardingHint).toBe('Portweiterleitung anpassen: game 25566 → 25600 (TCP)');
    expect(body.game.ports).toEqual([{ name: 'game', port: 25600, protocol: 'tcp' }]);
    expect(body.game.address.endsWith(':25600')).toBe(true);

    const write = rpcsOf(s, 'compose.write').slice(writes);
    expect(write).toHaveLength(1);
    const files = (write[0]?.params as { files: Record<string, string> }).files;
    expect(files['compose.yml']).toContain('25600');
    expect(files['compose.yml']).not.toContain('25566');
    // The RCON password stays in .env only, never in the response.
    expect(res.body).not.toContain('RCON_PASSWORD');
    expect(rpcsOf(s, 'compose.up').length).toBe(ups + 1);

    const audit = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === 'game.ports_changed');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.detailsJson ?? '{}')).toEqual({
      name: 'survival',
      changed: [{ name: 'game', from: 25566, to: 25600 }],
    });
  });

  it('a stopped game is not started; an unchanged port writes nothing', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await stepUp(s.t, s.secret, s.cookie);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/stop`)).statusCode).toBe(200);
    const writes = rpcsOf(s, 'compose.write').length;
    const ups = rpcsOf(s, 'compose.up').length;
    const same = gamePortsUpdateResponseSchema.parse(
      (await patchPorts(s, g.id, { ports: { game: 25566 } })).json(),
    );
    expect(same.changed).toEqual([]);
    expect(same.forwardingHint).toBeNull();
    expect(rpcsOf(s, 'compose.write').length).toBe(writes);
    const res = await patchPorts(s, g.id, { ports: { game: 26000 } });
    expect(res.statusCode).toBe(200);
    expect(rpcsOf(s, 'compose.write').length).toBe(writes + 1);
    expect(rpcsOf(s, 'compose.up').length).toBe(ups);
  });

  it('validates like on create: range, unknown names, conflicts', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const other = await readyGame(s, { name: 'creative' });
    const otherPort = other.ports[0]?.port ?? 0;
    await stepUp(s.t, s.secret, s.cookie);
    const writes = rpcsOf(s, 'compose.write').length;
    for (const payload of [
      { ports: { game: 80 } },
      { ports: { game: 70000 } },
      { ports: { game: 25600.5 } },
      { ports: { game: '25600' } },
      { ports: {} },
      { ports: { query: 25600 } },
      { ports: { game: 25600 }, extra: 1 },
      {},
    ]) {
      const res = await patchPorts(s, g.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Listening port of another process (java on 25565), another game, the own RCON port.
    const rconPort = s.t.db.db.select().from(gameServers).all()[0]?.rconPort ?? 0;
    for (const [port, status] of [
      [25565, 409],
      [otherPort, 409],
      [rconPort, 400],
    ] as const) {
      const res = await patchPorts(s, g.id, { ports: { game: port } });
      expect(res.statusCode, String(port)).toBe(status);
    }
    expect(rpcsOf(s, 'compose.write').length).toBe(writes);
    const unknown = await patchPorts(s, 'AAAAAAAAAAAAAAAA', { ports: { game: 25600 } });
    expect(unknown.statusCode).toBe(404);
  });

  it('needs step-up; without it nothing reaches the agent', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const before = s.rpcs.length;
    const res = await patchPorts(s, g.id, { ports: { game: 25600 } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    expect(s.rpcs.length).toBe(before);
    expect(s.t.app.hzCore.games.summary(g.id)?.ports[0]?.port).toBe(25566);
  });
});

describe('forwardingHint', () => {
  it('lists ranges and protocols, skips local ports', () => {
    expect(
      forwardingHint([
        { name: 'game', protocol: 'udp', count: 3, from: 2456, to: 2460, local: false },
        { name: 'api', protocol: 'tcp', count: 1, from: 8212, to: 8213, local: true },
        { name: 'query', protocol: 'tcp+udp', count: 1, from: 27015, to: 27016, local: false },
      ]),
    ).toBe(
      'Portweiterleitung anpassen: game 2456–2458 → 2460–2462 (UDP), query 27015 → 27016 (TCP+UDP)',
    );
    expect(
      forwardingHint([
        { name: 'api', protocol: 'tcp', count: 1, from: 8212, to: 8213, local: true },
      ]),
    ).toBeNull();
  });
});
