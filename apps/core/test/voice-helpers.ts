import { expect } from 'vitest';
import { voiceStateSchema, type GameSummary, type VoiceState } from '@hz/shared';
import { setupVoice, type VoiceHandle } from '../src/voice/index.js';
import { metricsMsg, stepUp, until, type WsClient } from './agent-helpers.js';
import { sideApp, type SideApp } from './discord-helpers.js';
import { readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import { FakeHa, HA_TOKEN } from './ha-helpers.js';
import { authHeaders } from './helpers.js';

export const SWITCH = 'input_boolean.survival';
export const STATUS = 'input_text.survival_status';

export interface VoiceSetup {
  s: GameSetup;
  game: GameSummary;
  ha: FakeHa;
  side: SideApp;
  voice: VoiceHandle;
}

export async function closeVoice(v: VoiceSetup | undefined): Promise<void> {
  if (!v) return;
  v.voice.shutdown();
  await v.side.app.close();
  await v.s.t.app.close();
  await v.ha.stop();
}

/** Game app + fake HA (with the helpers) + the voice routes on a side app. */
export async function setupVoiceTest(
  clients: WsClient[],
  onCreate: (v: VoiceSetup) => void,
  opts: { captureLogs?: boolean } = {},
): Promise<VoiceSetup> {
  const ha = new FakeHa();
  ha.put(SWITCH, 'off', { friendly_name: 'Minecraft' });
  ha.put(STATUS, '', { friendly_name: 'Minecraft Status', max: 100 });
  await ha.start();
  const s = await withGames(clients, { captureLogs: opts.captureLogs ?? false });
  const game = await readyGame(s);
  let voice: VoiceHandle | undefined;
  const side = await sideApp(s.t, async (app) => {
    voice = await setupVoice(app, {
      db: s.t.db.db,
      now: () => s.t.clock.t,
      log: app.log,
      ha: s.t.app.hzCore.ha,
      games: s.t.app.hzCore.games,
    });
  });
  if (!voice) throw new Error('no voice');
  const v: VoiceSetup = { s, game, ha, side, voice };
  onCreate(v);
  await stepUp(s.t, s.secret, s.cookie);
  const res = await s.t.app.inject({
    method: 'PUT',
    url: '/api/ha/settings',
    headers: authHeaders(s.cookie),
    payload: { url: ha.url, token: HA_TOKEN },
  });
  if (res.statusCode !== 200) throw new Error(`ha settings ${res.statusCode}`);
  await until(() => s.t.app.hzCore.ha.settings().status === 'connected');
  return v;
}

export function putGame(v: VoiceSetup, gameId: string, payload: unknown) {
  return v.side.app.inject({
    method: 'PUT',
    url: `/api/voice/games/${gameId}`,
    headers: authHeaders(v.s.cookie),
    payload: payload as Record<string, unknown>,
  });
}

export async function voiceState(v: VoiceSetup): Promise<VoiceState> {
  const res = await v.side.app.inject({
    method: 'GET',
    url: '/api/voice',
    headers: authHeaders(v.s.cookie),
  });
  expect(res.statusCode).toBe(200);
  return voiceStateSchema.parse(res.json());
}

/** Waits for HA echoes, voice triggers and game actions. */
export async function settle(v: VoiceSetup): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 40));
    await v.voice.idle();
    await v.s.t.app.hzCore.games.idle();
  }
}

export async function freshMetrics(s: GameSetup): Promise<void> {
  s.agent.send(metricsMsg({ ramPct: 40 }));
  await s.keepAlive();
}

export const callsOf = (v: VoiceSetup, service: string, entity: string) =>
  v.ha.calls.filter(
    (c) =>
      c.service === service &&
      (c.target as { entity_id?: string } | undefined)?.entity_id === entity,
  );

export const ups = (v: VoiceSetup): number => rpcsOf(v.s, 'compose.up').length;
export const downs = (v: VoiceSetup): number => rpcsOf(v.s, 'compose.down').length;

export function triggers(v: VoiceSetup): { result: string; to: string; error?: string }[] {
  return (
    v.s.t.db.sqlite
      .prepare("SELECT details_json AS d FROM audit_log WHERE action = 'voice.trigger' ORDER BY id")
      .all() as { d: string }[]
  ).map((r) => JSON.parse(r.d) as { result: string; to: string });
}

/** Configures the game with step-up and switches the module on. */
export async function configure(
  v: VoiceSetup,
  body: { switchEntity?: string | null; statusEntity?: string | null; allowStop?: boolean } = {},
): Promise<void> {
  await stepUp(v.s.t, v.s.secret, v.s.cookie);
  const res = await putGame(v, v.game.id, {
    switchEntity: SWITCH,
    statusEntity: STATUS,
    allowStop: false,
    ...body,
  });
  if (res.statusCode !== 200) throw new Error(`voice game ${res.statusCode} ${res.body}`);
  v.voice.setEnabled(true);
  await settle(v);
}
