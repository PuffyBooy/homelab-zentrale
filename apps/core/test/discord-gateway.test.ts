import { afterEach, describe, expect, it } from 'vitest';
import {
  backoffDelay,
  checkGatewayUrl,
  DiscordGateway,
  type GatewayDownReason,
  type GatewayReadyInfo,
} from '../src/discord/gateway.js';
import { DISCORD_API, DiscordRest, DiscordRestError } from '../src/discord/rest.js';
import { until } from './agent-helpers.js';
import { BOT_TOKEN, FakeGateway, FakeRest, OTHER_BOT_TOKEN } from './discord-helpers.js';

interface Recorder {
  ready: GatewayReadyInfo[];
  resumed: number;
  down: { reason: GatewayDownReason; willRetry: boolean }[];
  interactions: unknown[];
}

let fake: FakeGateway | undefined;
let gw: DiscordGateway | undefined;
afterEach(async () => {
  gw?.stop();
  gw = undefined;
  await fake?.stop();
  fake = undefined;
});

async function connect(
  opts: {
    token?: string;
    rest?: FakeRest;
    random?: () => number;
    setup?: (f: FakeGateway) => void;
  } = {},
): Promise<{ f: FakeGateway; rec: Recorder; rest: FakeRest }> {
  const f = new FakeGateway();
  opts.setup?.(f);
  await f.start();
  fake = f;
  const rest = opts.rest ?? new FakeRest();
  const rec: Recorder = { ready: [], resumed: 0, down: [], interactions: [] };
  gw = new DiscordGateway(
    opts.token ?? BOT_TOKEN,
    new DiscordRest(opts.token ?? BOT_TOKEN, rest.fetch),
    {
      connecting: () => undefined,
      ready: (i) => rec.ready.push(i),
      resumed: () => {
        rec.resumed += 1;
      },
      interaction: (d) => rec.interactions.push(d),
      down: (reason, willRetry) => rec.down.push({ reason, willRetry }),
    },
    f.factory,
    {
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      readyTimeoutMs: 2_000,
      random: opts.random ?? (() => 0.5),
    },
  );
  gw.start();
  return { f, rec, rest };
}

describe('discord gateway: host check', () => {
  it('accepts only wss on a discord.gg subdomain without credentials or port', () => {
    expect(checkGatewayUrl('wss://gateway.discord.gg')).toBe('wss://gateway.discord.gg');
    expect(checkGatewayUrl('wss://gateway-us-east1-b.discord.gg/')).toBe(
      'wss://gateway-us-east1-b.discord.gg',
    );
    for (const bad of [
      'ws://gateway.discord.gg',
      'https://gateway.discord.gg',
      'wss://gateway.discord.gg.evil.example',
      'wss://evildiscord.gg',
      'wss://discord.gg',
      'wss://evil.example/?h=.discord.gg',
      'wss://user:pw@gateway.discord.gg',
      'wss://gateway.discord.gg:8443',
      'wss://127.0.0.1',
      'not a url',
    ]) {
      expect(checkGatewayUrl(bad), bad).toBeNull();
    }
  });

  it('refuses a gateway URL from /gateway/bot outside discord.gg and does not connect', async () => {
    const rest = new FakeRest();
    rest.gatewayUrl = 'wss://evil.example';
    const { f, rec } = await connect({ rest });
    await until(() => rec.down.length > 0);
    expect(rec.down[0]).toEqual({ reason: 'bad_url', willRetry: false });
    expect(f.requested).toEqual([]);
    expect(f.connections).toBe(0);
  });

  it('ignores a resume URL outside discord.gg and identifies anew on the main gateway', async () => {
    const { f, rec } = await connect({
      setup: (g) => {
        g.resumeUrl = 'wss://resume.evil.example';
      },
    });
    await until(() => rec.ready.length === 1);
    f.closeAll(4000);
    await until(() => rec.ready.length === 2);
    expect(f.ofOp(6)).toHaveLength(0);
    expect(f.requested).toEqual([
      'wss://gateway.discord.gg/?v=10&encoding=json',
      'wss://gateway.discord.gg/?v=10&encoding=json',
    ]);
  });
});

describe('discord gateway: protocol', () => {
  it('identifies with intents 0 after HELLO and reports READY', async () => {
    const { f, rec, rest } = await connect();
    await until(() => rec.ready.length === 1);
    expect(rec.ready[0]).toEqual({ userName: 'Zentrale', applicationId: f.applicationId });
    expect(f.requested[0]).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    const identify = f.ofOp(2)[0]?.d as { token: string; intents: number };
    expect(identify.token).toBe(BOT_TOKEN);
    expect(identify.intents).toBe(0);
    // REST: only discord.com, bot token in the header, redirects refused.
    expect(rest.calls[0]?.url).toBe(`${DISCORD_API}/gateway/bot`);
    expect(rest.calls[0]?.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(rest.calls[0]?.redirect).toBe('error');
    expect(gw?.connected).toBe(true);
  });

  it('heartbeats with the last sequence and gets ACKs', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    await until(() => f.ofOp(1).length >= 3, 3_000);
    expect(f.connections).toBe(1);
    expect(f.ofOp(1).at(-1)?.d).toBe(f.seq);
  });

  it('answers a heartbeat request (op 1) at once', async () => {
    const { f, rec } = await connect();
    f.heartbeatInterval = 60_000;
    await until(() => rec.ready.length === 1);
    const before = f.ofOp(1).length;
    f.send({ op: 1, d: null });
    await until(() => f.ofOp(1).length > before);
  });

  it('a missing HEARTBEAT_ACK (zombie) reconnects and resumes the session', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.ackHeartbeats = false;
    await until(() => rec.resumed === 1, 4_000);
    const resume = f.ofOp(6)[0]?.d as { token: string; session_id: string; seq: number };
    expect(resume.session_id).toBe('session-1');
    expect(resume.token).toBe(BOT_TOKEN);
    expect(typeof resume.seq).toBe('number');
    expect(f.requested[1]).toMatch(/^wss:\/\/gateway-us-east1-b\.discord\.gg\//);
  });

  it('resumes after a dropped connection and after op 7 reconnect', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.dispatch('INTERACTION_CREATE', { id: 'x' });
    await until(() => rec.interactions.length === 1);
    const seqBefore = f.seq;
    f.closeAll(4000);
    await until(() => rec.resumed === 1);
    expect((f.ofOp(6)[0]?.d as { seq: number }).seq).toBe(seqBefore);
    f.send({ op: 7, d: null });
    await until(() => rec.resumed === 2);
    expect(f.ofOp(2)).toHaveLength(1);
  });

  it('op 9 invalid session (not resumable) identifies again', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.send({ op: 9, d: false });
    await until(() => rec.ready.length === 2);
    expect(f.ofOp(2)).toHaveLength(2);
    expect(f.ofOp(6)).toHaveLength(0);
  });

  it('close 4009 (session timed out) starts a new session', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.closeAll(4009);
    await until(() => rec.ready.length === 2);
    expect(f.ofOp(6)).toHaveLength(0);
  });

  it('close 4004 (token invalid) stops retrying', async () => {
    const f = new FakeGateway();
    f.tokens.clear();
    f.tokens.add(OTHER_BOT_TOKEN);
    await f.start();
    fake = f;
    const rest = new FakeRest();
    const down: GatewayDownReason[] = [];
    gw = new DiscordGateway(
      BOT_TOKEN,
      new DiscordRest(BOT_TOKEN, rest.fetch),
      {
        connecting: () => undefined,
        ready: () => undefined,
        resumed: () => undefined,
        interaction: () => undefined,
        down: (r) => down.push(r),
      },
      f.factory,
      { backoffBaseMs: 10, backoffMaxMs: 20 },
    );
    gw.start();
    await until(() => down.length === 1);
    expect(down[0]).toBe('auth_invalid');
    await new Promise((r) => setTimeout(r, 150));
    expect(f.connections).toBe(1);
    expect(down).toHaveLength(1);
  });

  it('REST 401 on /gateway/bot is token invalid, without connecting', async () => {
    const { f, rec } = await connect({ token: OTHER_BOT_TOKEN });
    await until(() => rec.down.length === 1);
    expect(rec.down[0]).toEqual({ reason: 'auth_invalid', willRetry: false });
    expect(f.connections).toBe(0);
  });

  it('close 4014 (disallowed intents) is fatal', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.closeAll(4014);
    await until(() => rec.down.length === 1);
    expect(rec.down[0]).toEqual({ reason: 'fatal', willRetry: false });
  });

  it('frames larger than 1 MiB drop the connection', async () => {
    const { f, rec } = await connect();
    await until(() => rec.ready.length === 1);
    f.dispatch('INTERACTION_CREATE', { pad: 'x'.repeat(1024 * 1024 + 10) });
    await until(() => rec.down.length >= 1);
    expect(rec.interactions).toHaveLength(0);
    // Not fatal: it reconnects and resumes.
    await until(() => rec.resumed === 1);
  });
});

describe('discord gateway: backoff and REST', () => {
  it('backoff doubles with jitter up to the cap', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBe(4000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('REST errors carry only the status, never URL or token', async () => {
    const rest = new DiscordRest(BOT_TOKEN, async () => new Response('nope', { status: 403 }));
    const err = await rest
      .putGuildCommands('111111111111111111', '222222222222222222', [])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordRestError);
    expect((err as DiscordRestError).status).toBe(403);
    expect(String((err as Error).message)).not.toContain(BOT_TOKEN);
    expect(String((err as Error).message)).not.toContain('discord.com');
  });

  it('refuses path segments that could leave the API path', async () => {
    const urls: string[] = [];
    const rest = new DiscordRest(BOT_TOKEN, async (url) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    });
    await expect(
      rest.callback('1', '../../evil', { type: 5, data: { flags: 64 } }),
    ).rejects.toBeInstanceOf(DiscordRestError);
    await expect(
      rest.editOriginal('1', 'a/b', { content: 'x', allowed_mentions: { parse: [] } }),
    ).rejects.toBeInstanceOf(DiscordRestError);
    expect(urls).toEqual([]);
  });

  it('interaction callbacks carry no bot token', async () => {
    const f = new FakeRest();
    const rest = new DiscordRest(BOT_TOKEN, f.fetch);
    await rest.callback('123456789012345678', 'aW50ZXJhY3Rpb24tdG9rZW4', {
      type: 5,
      data: { flags: 64 },
    });
    expect(f.calls[0]?.headers.authorization).toBeUndefined();
    expect(f.calls[0]?.url.startsWith(DISCORD_API)).toBe(true);
  });
});
