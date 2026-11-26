import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { randomToken, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import {
  gamePlayerHours,
  gamePlayerSessions,
  gameSchedules,
  gameServers,
  whitelistRequests,
} from '../db/schema.js';
import type { LoadedTemplate } from '../games/templates.js';

const HOUR = 60 * 60_000;
const DEMO_GAME = 'survival';
const DEMO_PLAYERS = ['Steve', 'Alex', 'mia_k'] as const;

/**
 * M12 demo data (HZ_DEMO=1 only): a sleeping Minecraft server on the first demo
 * server with a week of player statistics, a backup schedule and one open
 * whitelist request, so the game pages and screenshots show the new parts.
 * Demo servers have no agent: actions answer agent_offline.
 */
export function seedDemoGames(deps: {
  db: Db;
  now: Clock;
  serverIds: readonly string[];
  templates: Map<string, LoadedTemplate>;
  box: SecretBox;
}): string | null {
  const { db } = deps;
  const serverId = deps.serverIds[0];
  const tpl = deps.templates.get('minecraft-java')?.template;
  if (!serverId || !tpl) return null;
  const existing = db
    .select({ id: gameServers.id })
    .from(gameServers)
    .where(and(eq(gameServers.serverId, serverId), eq(gameServers.name, DEMO_GAME)))
    .get();
  if (existing) return existing.id;
  const t0 = deps.now();
  const id = randomToken(12);
  const values: Record<string, string | number | boolean> = {};
  for (const f of tpl.fields) {
    if (f.type !== 'text' || !f.secret) values[f.key] = f.default;
  }
  const port = tpl.ports[0];
  db.insert(gameServers)
    .values({
      id,
      serverId,
      templateId: tpl.id,
      name: DEMO_GAME,
      settingsJson: JSON.stringify(values),
      portsJson: JSON.stringify(
        port
          ? [{ name: port.name, port: port.default, protocol: port.protocol, count: port.count }]
          : [],
      ),
      // RCON like a real game (whitelist requests need it); the demo has no agent anyway.
      rconPort: tpl.rcon.supported ? 25575 : null,
      rconSecretEnc: tpl.rcon.supported
        ? deps.box.encrypt(randomToken(24), `game_servers.rcon:${id}`)
        : null,
      secretValuesEnc: null,
      externalAddress: 'mc.example.org',
      autoStopMinutes: 15,
      wakeOnConnect: true,
      sleeping: true,
      modsRestartNeeded: false,
      phase: 'stopped',
      phaseText: null,
      statusJson: JSON.stringify({
        online: false,
        players: null,
        version: 'Paper 1.21.4',
        tps: null,
      }),
      statusAt: null,
      emptySince: null,
      createdAt: t0 - 14 * 24 * HOUR,
      updatedAt: t0,
    })
    .run();
  db.insert(gameSchedules)
    .values({
      id: randomToken(12),
      gameId: id,
      position: 0,
      kind: 'backup',
      daysJson: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
      time: '04:00',
      enabled: true,
      lastRunAt: null,
      createdAt: t0,
    })
    .run();
  // A week of evenings: 18-22 h with one to three players.
  const today = Math.floor(t0 / HOUR) * HOUR;
  for (let d = 7; d >= 1; d -= 1) {
    for (let h = 17; h <= 21; h += 1) {
      const hourTs = today - d * 24 * HOUR - ((today / HOUR) % 24) * HOUR + h * HOUR;
      const online = 1 + ((d + h) % 3);
      db.insert(gamePlayerHours)
        .values({
          gameId: id,
          hourTs,
          samples: 120,
          playersSum: online * 120,
          peak: online,
          peakAt: hourTs + 20 * 60_000,
        })
        .run();
      DEMO_PLAYERS.slice(0, online).forEach((player) => {
        db.insert(gamePlayerSessions)
          .values({
            gameId: id,
            player,
            startedAt: hourTs,
            lastSeen: hourTs + 55 * 60_000,
            endedAt: hourTs + 55 * 60_000,
          })
          .run();
      });
    }
  }
  db.insert(whitelistRequests)
    .values({
      id: randomToken(12),
      gameId: id,
      shareId: randomToken(12),
      person: 'Max',
      player: 'Steve',
      state: 'pending',
      createdAt: t0 - 20 * 60_000,
      decidedAt: null,
    })
    .run();
  return id;
}
