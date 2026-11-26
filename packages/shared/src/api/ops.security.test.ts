import { describe, expect, it } from 'vitest';
import { parseRpc } from '../agent-protocol.js';
import { pinnedImageRefSchema, TRIVY_IMAGE_DEFAULT } from '../agent-ops.js';
import { MODULE_DEFAULTS, MODULES_ENABLE_STEP_UP } from './modules.js';
import {
  discordBotSettingsRequestSchema,
  discordBotStateSchema,
  fail2banUnbanRequestSchema,
  logSearchRequestSchema,
  voiceGameRequestSchema,
} from './ops.js';

const rpc = (action: string, params: unknown) =>
  parseRpc({ type: 'rpc', id: 'rpc_abcdefgh', action, params });

describe('ops modules: defaults and step-up', () => {
  it('all five modules are off on a fresh install', () => {
    for (const m of ['logsearch', 'vulnscan', 'fail2ban', 'discordbot', 'voice'] as const) {
      expect(MODULE_DEFAULTS[m]).toBe(false);
    }
  });
  it('control from outside (Discord, Alexa) needs step-up to switch on', () => {
    expect(MODULES_ENABLE_STEP_UP).toContain('discordbot');
    expect(MODULES_ENABLE_STEP_UP).toContain('voice');
  });
});

describe('logs.search', () => {
  it('accepts a plain query with regex characters (matched literally by the agent)', () => {
    expect(rpc('logs.search', { query: 'error.*(' }).ok).toBe(true);
  });
  it('rejects control characters, too short and too long queries', () => {
    expect(rpc('logs.search', { query: 'a' }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'a\nb' }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'x\u0000y' }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'x'.repeat(201) }).ok).toBe(false);
  });
  it('bounds time range, matches and container refs', () => {
    expect(rpc('logs.search', { query: 'ab', sinceMinutes: 7 * 24 * 60 + 1 }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'ab', maxMatches: 501 }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'ab', containers: ['../etc'] }).ok).toBe(false);
    expect(rpc('logs.search', { query: 'ab', containers: ['-v'] }).ok).toBe(false);
  });
  it('the admin request has no free-form container ref', () => {
    expect(logSearchRequestSchema.safeParse({ query: 'ab', container: 'a b' }).success).toBe(false);
    expect(logSearchRequestSchema.safeParse({ query: 'ab', regex: true }).success).toBe(false);
  });
});

describe('image.scan', () => {
  it('takes only a container ref, never an image or scanner option', () => {
    expect(rpc('image.scan', { id: 'nginx' }).ok).toBe(true);
    expect(rpc('image.scan', { id: 'nginx', image: 'evil/x' }).ok).toBe(false);
    expect(rpc('image.scan', { id: '--config=/x' }).ok).toBe(false);
  });
  it('the default scanner image is pinned by digest', () => {
    expect(TRIVY_IMAGE_DEFAULT).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(pinnedImageRefSchema.safeParse(TRIVY_IMAGE_DEFAULT).success).toBe(true);
  });
  it('pinned refs need a digest and cannot start with a dash', () => {
    const d = `sha256:${'a'.repeat(64)}`;
    expect(pinnedImageRefSchema.safeParse(`nginx@${d}`).success).toBe(true);
    expect(pinnedImageRefSchema.safeParse(`ghcr.io/a/b:1.2@${d}`).success).toBe(true);
    expect(pinnedImageRefSchema.safeParse('nginx:latest').success).toBe(false);
    expect(pinnedImageRefSchema.safeParse(`-nginx@${d}`).success).toBe(false);
    expect(pinnedImageRefSchema.safeParse(`nginx@${d} --x`).success).toBe(false);
  });
});

describe('fail2ban', () => {
  it('unban takes a jail name and a single IP only', () => {
    expect(rpc('fail2ban.unban', { jail: 'sshd', ip: '203.0.113.7' }).ok).toBe(true);
    expect(rpc('fail2ban.unban', { jail: 'sshd', ip: '2001:db8::1' }).ok).toBe(true);
    expect(rpc('fail2ban.unban', { jail: 'sshd', ip: '203.0.113.7; rm -rf /' }).ok).toBe(false);
    expect(rpc('fail2ban.unban', { jail: 'sshd', ip: '203.0.113.0/24' }).ok).toBe(false);
    expect(rpc('fail2ban.unban', { jail: '-h', ip: '203.0.113.7' }).ok).toBe(false);
    expect(rpc('fail2ban.unban', { jail: 'a b', ip: '203.0.113.7' }).ok).toBe(false);
    expect(rpc('fail2ban.status', { jail: 'x' }).ok).toBe(false);
  });
  it('the admin request is strict', () => {
    const ok = { serverId: 'srv_abcdefgh', jail: 'sshd', ip: '198.51.100.1' };
    expect(fail2banUnbanRequestSchema.safeParse(ok).success).toBe(true);
    expect(fail2banUnbanRequestSchema.safeParse({ ...ok, cmd: 'x' }).success).toBe(false);
  });
});

describe('discordbot', () => {
  it('the state never carries the token', () => {
    expect(Object.keys(discordBotStateSchema.shape)).not.toContain('token');
    const state = {
      tokenSet: true,
      applicationId: '123456789012345678',
      guildId: '123456789012345678',
      status: 'online',
      statusText: 'Verbunden',
      bindings: [],
      token: 'x',
    };
    expect(discordBotStateSchema.safeParse(state).success).toBe(false);
  });
  it('ids are snowflakes, tokens have a strict shape', () => {
    const base = { applicationId: '123456789012345678', guildId: null };
    expect(discordBotSettingsRequestSchema.safeParse(base).success).toBe(true);
    expect(
      discordBotSettingsRequestSchema.safeParse({ ...base, applicationId: '12; DROP' }).success,
    ).toBe(false);
    expect(discordBotSettingsRequestSchema.safeParse({ ...base, token: 'short' }).success).toBe(
      false,
    );
    expect(
      discordBotSettingsRequestSchema.safeParse({ ...base, token: `${'a'.repeat(60)}\n` }).success,
    ).toBe(false);
  });
});

describe('voice', () => {
  it('only input_boolean switches and input_text status helpers', () => {
    const ok = { switchEntity: 'input_boolean.minecraft', statusEntity: null, allowStop: false };
    expect(voiceGameRequestSchema.safeParse(ok).success).toBe(true);
    for (const e of [
      'switch.haustuer',
      'lock.tuer',
      'script.x',
      'input_boolean.',
      'input_boolean.A',
    ]) {
      expect(voiceGameRequestSchema.safeParse({ ...ok, switchEntity: e }).success).toBe(false);
    }
    expect(
      voiceGameRequestSchema.safeParse({ ...ok, statusEntity: 'input_boolean.x' }).success,
    ).toBe(false);
  });
});
