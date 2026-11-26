import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  backupFileNameSchema,
  modFileNameSchema,
  modrinthCdnUrlSchema,
  rpcParamsByAction,
} from '../agent-protocol.js';
import { discordWebhookUrlSchema, gameSchedulesSchema } from './game-features.js';
import { shareWhitelistAskSchema } from './share.js';

const cdn = 'https://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/sodium-0.6.jar';

describe('M12 schemas (security)', () => {
  it('accepts only Modrinth CDN jar URLs', () => {
    expect(modrinthCdnUrlSchema.safeParse(cdn).success).toBe(true);
    for (const bad of [
      'http://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/a.jar',
      'https://cdn.modrinth.com.evil.at/data/AANobbMI/versions/abcd1234/a.jar',
      'https://evil.at/https://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/a.jar',
      'https://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/../../x.jar',
      'https://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/a%2f..%2fb.jar',
      'https://cdn.modrinth.com/data/AANobbMI/versions/abcd1234/a.sh',
      'https://user@cdn.modrinth.com/data/AANobbMI/versions/abcd1234/a.jar',
    ]) {
      expect(modrinthCdnUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('rejects jar names with paths or dots in front', () => {
    expect(modFileNameSchema.safeParse('EssentialsX-2.20.1.jar').success).toBe(true);
    for (const bad of ['../x.jar', 'a/b.jar', '.hidden.jar', 'x..jar', 'x.jar\0', 'x.zip', '']) {
      expect(modFileNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts only backup archive names', () => {
    expect(backupFileNameSchema.safeParse('survival-20261126-120000.tar.zst').success).toBe(true);
    for (const bad of [
      '../survival-20261126-120000.tar.zst',
      'survival.tar.zst',
      '.export-x.tar.zst',
    ]) {
      expect(backupFileNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('world paths stay inside data/', () => {
    const exp = rpcParamsByAction['game.export'];
    expect(exp.safeParse({ gameId: 'survival', paths: ['world', 'world_nether'] }).success).toBe(
      true,
    );
    for (const bad of ['../x', 'world/../../etc', '/etc', '.', 'a//b', '.rcon-cli.env', '']) {
      expect(exp.safeParse({ gameId: 'survival', paths: [bad] }).success, bad).toBe(false);
    }
  });

  it('accepts only Discord webhook URLs', () => {
    expect(
      discordWebhookUrlSchema.safeParse('https://discord.com/api/webhooks/123/abc_DEF-1').success,
    ).toBe(true);
    for (const bad of [
      'http://discord.com/api/webhooks/123/abc',
      'https://discord.com.evil.at/api/webhooks/123/abc',
      'https://evil.at/api/webhooks/123/abc',
      'https://discord.com/api/webhooks/123/abc?wait=true',
      'https://127.0.0.1/api/webhooks/123/abc',
    ]) {
      expect(discordWebhookUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('bounds wake listeners to unprivileged ports and few of them', () => {
    const arm = rpcParamsByAction['game.wake.arm'];
    const ok = {
      gameId: 'survival',
      mode: 'minecraft',
      ports: [{ port: 25565, protocol: 'tcp' }],
      motd: 'Schläft',
    };
    expect(arm.safeParse(ok).success).toBe(true);
    expect(arm.safeParse({ ...ok, ports: [{ port: 22, protocol: 'tcp' }] }).success).toBe(false);
    expect(
      arm.safeParse({ ...ok, ports: Array(5).fill({ port: 25565, protocol: 'tcp' }) }).success,
    ).toBe(false);
    expect(arm.safeParse({ ...ok, gameId: '../etc' }).success).toBe(false);
    expect(arm.safeParse({ ...ok, motd: '§k<script>' }).success).toBe(false);
  });

  it('game_wake events carry no client address', () => {
    const ev = {
      type: 'event',
      ts: new Date().toISOString(),
      event: { kind: 'game_wake', gameId: 'survival', port: 25565, protocol: 'tcp', ip: '1.2.3.4' },
    };
    expect(agentEventSchema.safeParse(ev).success).toBe(false);
  });

  it('rejects bad schedules and player names', () => {
    expect(
      gameSchedulesSchema.safeParse({
        schedules: [{ kind: 'restart', days: [1, 1], time: '04:00', enabled: true }],
      }).success,
    ).toBe(false);
    expect(
      gameSchedulesSchema.safeParse({
        schedules: [{ kind: 'backup', days: [1], time: '24:00', enabled: true }],
      }).success,
    ).toBe(false);
    expect(shareWhitelistAskSchema.safeParse({ player: 'Steve; op Steve' }).success).toBe(false);
  });
});
