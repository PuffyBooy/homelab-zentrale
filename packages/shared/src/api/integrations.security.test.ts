import { describe, expect, it } from 'vitest';
import { parseRpc } from '../agent-protocol.js';
import {
  caCertSchema,
  discordWebhookSchema,
  dnsFilterBlockingRequestSchema,
  integrationSettingsRequestSchema,
  integrationUpdateNeedsStepUp,
  integrationUrlSchema,
  macSchema,
  notifyChannelUpdateNeedsStepUp,
  notifyChannelUpdateRequestSchema,
  proxmoxGuestActionParamsSchema,
  telegramBotTokenSchema,
  wolConfigRequestSchema,
} from './integrations.js';
import { MODULE_DEFAULTS, MODULES_ENABLE_STEP_UP } from './modules.js';

describe('integration URLs (SSRF)', () => {
  it('allows LAN, loopback and tailnet hosts', () => {
    for (const u of [
      'https://192.0.2.10:8006',
      'http://192.168.178.1:49000',
      'http://127.0.0.1:8080',
      'https://pihole.example.ts.net/',
    ]) {
      expect(integrationUrlSchema.safeParse(u).success, u).toBe(true);
    }
  });

  it('refuses link-local (cloud metadata), credentials, query, other schemes', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/',
      'http://0xa9.254.169.254/',
      'http://[fe80::1]/',
      'http://[::ffff:169.254.169.254]/',
      'https://user:pass@pve.lan:8006',
      'https://pve.lan:8006/?x=1',
      'https://pve.lan:8006/#a',
      'file:///etc/passwd',
      'gopher://pve.lan/',
      'ftp://pve.lan/',
    ]) {
      expect(integrationUrlSchema.safeParse(u).success, u).toBe(false);
    }
  });

  it('accepts only PEM certificates as CA', () => {
    const pem = `-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n`;
    expect(caCertSchema.safeParse(pem).success).toBe(true);
    expect(
      caCertSchema.safeParse('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').success,
    ).toBe(false);
    expect(caCertSchema.safeParse(`${pem}<script>`).success).toBe(false);
  });

  it('settings: unknown fields are refused, every credential change needs step-up', () => {
    expect(
      integrationSettingsRequestSchema.safeParse({ url: 'https://pve.lan', verify: false }).success,
    ).toBe(false);
    expect(integrationUpdateNeedsStepUp({ url: 'https://pve.lan' })).toBe(true);
    expect(integrationUpdateNeedsStepUp({ secret: 'x' })).toBe(true);
    expect(integrationUpdateNeedsStepUp({ username: null })).toBe(true);
    expect(integrationUpdateNeedsStepUp({ caCert: null })).toBe(true);
    expect(integrationUpdateNeedsStepUp({})).toBe(false);
    expect(integrationSettingsRequestSchema.safeParse({ secret: ' leading' }).success).toBe(false);
    expect(integrationSettingsRequestSchema.safeParse({ secret: 'a\nb' }).success).toBe(false);
  });

  it('modules are off by default and need step-up to switch on', () => {
    for (const m of ['proxmox', 'dnsfilter', 'fritzbox', 'uptimekuma'] as const) {
      expect(MODULE_DEFAULTS[m]).toBe(false);
      expect(MODULES_ENABLE_STEP_UP).toContain(m);
    }
  });
});

describe('Proxmox actions', () => {
  it('validates node, type, vmid and action', () => {
    const ok = { node: 'pve', type: 'qemu', vmid: '101', action: 'start' };
    expect(proxmoxGuestActionParamsSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, node: '../cluster' },
      { ...ok, node: 'pve/../../access' },
      { ...ok, type: 'storage' },
      { ...ok, vmid: '1' },
      { ...ok, vmid: '101;rm' },
      { ...ok, action: 'delete' },
      { ...ok, action: 'migrate' },
    ]) {
      expect(proxmoxGuestActionParamsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe('DNS filter', () => {
  it('a pause always has an end', () => {
    expect(dnsFilterBlockingRequestSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(dnsFilterBlockingRequestSchema.safeParse({ enabled: false, minutes: 0 }).success).toBe(
      false,
    );
    expect(
      dnsFilterBlockingRequestSchema.safeParse({ enabled: false, minutes: 9999 }).success,
    ).toBe(false);
    expect(dnsFilterBlockingRequestSchema.safeParse({ enabled: false, minutes: 15 }).success).toBe(
      true,
    );
    expect(dnsFilterBlockingRequestSchema.safeParse({ enabled: true }).success).toBe(true);
  });
});

describe('Wake-on-LAN', () => {
  it('normalises MACs and refuses broadcast/multicast/zero', () => {
    expect(macSchema.parse('aa-bb-cc-dd-ee-f0')).toBe('AA-BB-CC-DD-EE-F0'.replaceAll('-', ':'));
    for (const m of [
      'FF:FF:FF:FF:FF:FF',
      '00:00:00:00:00:00',
      '01:00:5E:00:00:01',
      'AA:BB:CC',
      'AA:BB:CC:DD:EE:FG',
    ]) {
      expect(macSchema.safeParse(m).success, m).toBe(false);
    }
  });

  it('broadcast only to 255.255.255.255 or private IPv4', () => {
    const base = { mac: 'AA:BB:CC:DD:EE:F0' };
    expect(wolConfigRequestSchema.safeParse({ ...base, broadcast: '192.168.1.255' }).success).toBe(
      true,
    );
    for (const b of [
      '8.8.8.8',
      '169.254.169.254',
      '127.0.0.1',
      '192.169.0.255',
      'example.com',
      '::1',
    ]) {
      expect(wolConfigRequestSchema.safeParse({ ...base, broadcast: b }).success, b).toBe(false);
    }
    expect(wolConfigRequestSchema.safeParse({ ...base, port: 22 }).success).toBe(false);
  });

  it('agent action wol.send accepts nothing but mac, broadcast and port 7/9', () => {
    const rpc = (params: unknown) =>
      parseRpc({ type: 'rpc', id: 'abcdefgh', action: 'wol.send', params });
    expect(rpc({ mac: 'AA:BB:CC:DD:EE:F0', broadcast: '255.255.255.255', port: 9 }).ok).toBe(true);
    expect(rpc({ mac: 'aa:bb:cc:dd:ee:f0', broadcast: '255.255.255.255', port: 9 }).ok).toBe(false);
    expect(rpc({ mac: 'AA:BB:CC:DD:EE:F0', broadcast: '1.1.1.1', port: 9 }).ok).toBe(false);
    expect(rpc({ mac: 'AA:BB:CC:DD:EE:F0', broadcast: '255.255.255.255', port: 53 }).ok).toBe(
      false,
    );
    expect(
      rpc({ mac: 'AA:BB:CC:DD:EE:F0', broadcast: '255.255.255.255', port: 9, payload: 'x' }).ok,
    ).toBe(false);
  });
});

describe('alert channels', () => {
  it('Discord webhooks only to discord.com', () => {
    const id = '123456789012345678';
    const tok = 'a'.repeat(68);
    expect(
      discordWebhookSchema.safeParse(`https://discord.com/api/webhooks/${id}/${tok}`).success,
    ).toBe(true);
    for (const u of [
      `http://discord.com/api/webhooks/${id}/${tok}`,
      `https://discord.com.evil.example/api/webhooks/${id}/${tok}`,
      `https://evil.example/discord.com/api/webhooks/${id}/${tok}`,
      `https://discord.com/api/webhooks/${id}/${tok}?wait=true`,
      `https://user@discord.com/api/webhooks/${id}/${tok}`,
      `https://169.254.169.254/api/webhooks/${id}/${tok}`,
    ]) {
      expect(discordWebhookSchema.safeParse(u).success, u).toBe(false);
    }
  });

  it('Telegram bot token cannot smuggle a path', () => {
    expect(telegramBotTokenSchema.safeParse(`123456:${'A'.repeat(35)}`).success).toBe(true);
    expect(telegramBotTokenSchema.safeParse(`123456:${'A'.repeat(35)}/../../x`).success).toBe(
      false,
    );
    expect(telegramBotTokenSchema.safeParse(`123456:${'A'.repeat(35)}@evil.example`).success).toBe(
      false,
    );
  });

  it('secret changes need step-up, level/enabled do not', () => {
    expect(notifyChannelUpdateNeedsStepUp({ enabled: true, minLevel: 'warn' })).toBe(false);
    expect(notifyChannelUpdateNeedsStepUp({ ntfyServer: 'https://ntfy.example.ts.net' })).toBe(
      true,
    );
    expect(notifyChannelUpdateNeedsStepUp({ ntfyToken: null })).toBe(true);
    expect(
      notifyChannelUpdateRequestSchema.safeParse({ ntfyServer: 'http://169.254.169.254' }).success,
    ).toBe(false);
    expect(notifyChannelUpdateRequestSchema.safeParse({ ntfyTopic: '../admin' }).success).toBe(
      false,
    );
  });
});
