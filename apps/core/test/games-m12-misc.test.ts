import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { gameTemplateListResponseSchema } from '@hz/shared';
import { servers } from '../src/db/schema.js';
import { forwardingHint, targetForwardingHint } from '../src/games/service.js';
import { stepUp, type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

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

const changed = [
  { name: 'game', protocol: 'tcp' as const, count: 1, from: 25565, to: 25570, local: false },
];

describe('network of a server and the forwarding hint (M12)', () => {
  it('PATCH network, validated; the port hint follows it', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const url = `/api/servers/${s.serverId}`;
    expect((await gameRequest(s, 'PATCH', url, { network: 'moon' })).statusCode).toBe(400);
    const res = await gameRequest(s, 'PATCH', url, { network: 'home' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ server: { network: 'home' } });
    await stepUp(s.t, s.secret, s.cookie);
    const ports = await gameRequest(s, 'PATCH', `/api/games/${g.id}/ports`, {
      ports: { game: 25570 },
    });
    expect(ports.json<{ forwardingHint: string }>().forwardingHint).toBe(
      `Router: Portweiterleitung anpassen: game ${g.ports[0]?.port} → 25570 (TCP)`,
    );
    expect((await gameRequest(s, 'PATCH', url, { network: null })).json()).toMatchObject({
      server: { network: null },
    });
  });

  it('texts per network', () => {
    expect(forwardingHint(changed, null)).toBe(
      'Portweiterleitung anpassen: game 25565 → 25570 (TCP)',
    );
    expect(forwardingHint(changed, 'cloud')).toMatch(
      /^Firewall des Anbieters \(z\. B\. Security List\) und iptables/,
    );
    expect(forwardingHint(changed, 'vps')).toMatch(/^Firewall des Anbieters anpassen/);
    expect(forwardingHint(changed, 'other')).toMatch(/^Portweiterleitung anpassen/);
    const hp = [{ name: 'game', port: 25570, protocol: 'tcp' as const, count: 1 }];
    expect(targetForwardingHint(hp, 'home')).toBe(
      'Router: Portweiterleitung am Ziel einrichten: game 25570 (TCP)',
    );
  });
});

describe('templates, arch, TZ, labels (M12)', () => {
  it('template list has wake, mods and arch', async () => {
    const s = await setup();
    const list = gameTemplateListResponseSchema.parse(
      (await gameRequest(s, 'GET', '/api/games/templates')).json(),
    );
    const mc = list.templates.find((x) => x.id === 'minecraft-java');
    expect(mc).toMatchObject({ wake: true, mods: true, arch: ['amd64', 'arm64'] });
    expect(list.templates.find((x) => x.id === 'valheim')).toMatchObject({
      wake: true,
      mods: false,
      arch: ['amd64'],
    });
  });

  it('refuses a server with an unsupported architecture (400 "Läuft nicht auf arm64")', async () => {
    const s = await setup();
    s.t.db.db.update(servers).set({ arch: 'arm64' }).where(eq(servers.id, s.serverId)).run();
    const res = await gameRequest(s, 'POST', '/api/games', {
      templateId: 'valheim',
      serverId: s.serverId,
      name: 'wikinger',
      values: { SERVER_PASS: 'geheim123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_input', message: 'Läuft nicht auf arm64' });
    expect(rpcsOf(s, 'compose.write')).toHaveLength(0);
  });

  it('compose.yml gets TZ from HZ_TIMEZONE; the container is linked by its label', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const compose = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> })
      .files['compose.yml'];
    expect(compose).toContain('TZ: "Europe/Vienna"');
    const c = s.t.app.hzCore.containers.list().find((x) => x.name === 'game-survival');
    expect(c?.game).toBe('survival');
    expect(s.t.app.hzCore.games.containerIdOf(g.id)).toBe(c?.id);
  });
});

describe('demo data (M12, HZ_DEMO=1)', () => {
  it('a sleeping game with statistics, schedule and an open whitelist request', async () => {
    t = await makeApp({ env: { HZ_DEMO: '1' } });
    const admin = await completeSetup(t);
    const h = authHeaders(admin.cookie);
    const games = (await t.app.inject({ method: 'GET', url: '/api/games', headers: h })).json<{
      games: { id: string; sleeping: boolean; statusText: string; rcon: boolean }[];
    }>().games;
    const g = games.find((x) => x.sleeping);
    expect(g).toMatchObject({ statusText: 'Schläft', rcon: true });
    const id = g?.id ?? '';
    const stats = (
      await t.app.inject({ method: 'GET', url: `/api/games/${id}/stats`, headers: h })
    ).json<{
      players: unknown[];
    }>();
    expect(stats.players.length).toBeGreaterThan(0);
    const sched = (
      await t.app.inject({ method: 'GET', url: `/api/games/${id}/schedules`, headers: h })
    ).json<{
      schedules: unknown[];
    }>();
    expect(sched.schedules).toHaveLength(1);
    const wl = (
      await t.app.inject({ method: 'GET', url: `/api/games/${id}/whitelist-requests`, headers: h })
    ).json<{ requests: { state: string }[] }>();
    expect(wl.requests[0]?.state).toBe('pending');
  });
});
