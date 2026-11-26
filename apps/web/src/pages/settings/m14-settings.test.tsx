import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDisplayTimeZone } from '../../lib/format.js';
import { MODULE_HINT, MODULE_LABEL } from '../../lib/modules.js';
import { channel, settings } from '../../test-m14.js';
import { enabledIntegrations, IntegrationForm } from './IntegrationTiles.js';
import { ChannelSection } from './NotifyChannelsTile.js';

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

describe('Module tile labels', () => {
  it('has German labels and a line for the new modules', () => {
    expect(MODULE_LABEL.proxmox).toBe('Proxmox');
    expect(MODULE_LABEL.dnsfilter).toBe('DNS-Filter (Pi-hole/AdGuard)');
    expect(MODULE_LABEL.fritzbox).toBe('FRITZ!Box');
    expect(MODULE_LABEL.uptimekuma).toBe('Uptime Kuma');
    for (const id of ['proxmox', 'dnsfilter', 'fritzbox', 'uptimekuma'] as const)
      expect(MODULE_HINT[id].length).toBeGreaterThan(10);
  });
});

describe('Einstellungen → Anbindungen', () => {
  it('shows one tile per switched-on integration', () => {
    expect(
      enabledIntegrations({
        github: true,
        homeassistant: false,
        games: true,
        proxmox: true,
        dnsfilter: false,
        fritzbox: true,
        uptimekuma: false,
        storage: true,
      }),
    ).toEqual(['proxmox', 'fritzbox']);
  });

  it('Proxmox: token id field, secret never prefilled ("gesetzt"), CA, note under URL', () => {
    const out = html(<IntegrationForm id="proxmox" settings={settings()} />);
    expect(out).toContain('API-Token-ID (benutzer@realm!name)');
    expect(out).toContain('value="hz@pve!zentrale"');
    expect(out).toContain('API-Token-Secret');
    const secret = /<input[^>]*type="password"[^>]*>/.exec(out)?.[0] ?? '';
    expect(secret).toContain('placeholder="gesetzt"');
    expect(secret).not.toMatch(/value="[^"]/);
    expect(out).toContain('Wechselt die Adresse, musst du das Token neu eintragen.');
    expect(out).toContain('CA-Zertifikat (PEM), nur bei selbst signiertem Zertifikat');
    expect(out).toContain('<textarea');
    expect(out).toContain('Verbindung testen');
    expect(out).toContain('>Entfernen<');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('23:04');
  });

  it('Pi-hole has only a password, AdGuard a user; variant select', () => {
    const pi = html(
      <IntegrationForm
        id="dnsfilter"
        settings={settings({ url: 'http://192.168.1.2', username: null, variant: 'pihole' })}
      />,
    );
    expect(pi).toContain('Pi-hole v6');
    expect(pi).toContain('AdGuard Home');
    expect(pi).not.toContain('>Benutzer<');
    expect(pi).toContain('App-Passwort');
    const ag = html(
      <IntegrationForm
        id="dnsfilter"
        settings={settings({ url: 'http://192.168.1.2', username: 'admin', variant: 'adguard' })}
      />,
    );
    expect(ag).toContain('>Benutzer<');
  });

  it('error and not set up states', () => {
    const bad = html(
      <IntegrationForm
        id="fritzbox"
        settings={settings({ status: 'error', error: 'Zugangsdaten ungültig', username: 'hz' })}
      />,
    );
    expect(bad).toContain('Fehler: Zugangsdaten ungültig');
    expect(bad).toContain('hz-status-warn');
    const off = html(
      <IntegrationForm
        id="uptimekuma"
        settings={settings({
          url: null,
          username: null,
          secretSet: false,
          status: 'off',
          lastOkAt: null,
        })}
      />,
    );
    expect(off).toContain('nicht eingerichtet');
    expect(off).toContain('noch nie');
    expect(off).not.toContain('>Entfernen<');
    expect(off).toMatch(/<button[^>]*disabled[^>]*>.*Verbindung testen/);
  });
});

describe('Einstellungen → Meldungskanäle', () => {
  it('Discord: toggle, level, webhook field, test disabled until configured', () => {
    const out = html(<ChannelSection channel={channel()} />);
    expect(out).toContain('Discord');
    expect(out).toContain('hz-toggle');
    expect(out).toContain('Mindest-Level');
    expect(out).toContain('>Warnung<');
    expect(out).toContain('Webhook-URL');
    expect(out).toContain('nicht eingerichtet');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>.*Testnachricht/);
    expect(out).not.toContain('>Entfernen<');
  });

  it('Telegram configured: secrets show "gesetzt", last sent and last error', () => {
    const out = html(
      <ChannelSection
        channel={channel({
          id: 'telegram',
          configured: true,
          enabled: true,
          lastSentAt: '2026-11-26T22:04:00.000Z',
          lastError: 'HTTP 401',
        })}
      />,
    );
    expect(out).toContain('Bot-Token');
    expect(out).toContain('Chat-ID');
    expect(out).toContain('placeholder="gesetzt"');
    expect(out).toContain('23:04');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('>Entfernen<');
  });

  it('ntfy: server, topic, optional token', () => {
    const out = html(<ChannelSection channel={channel({ id: 'ntfy' })} />);
    expect(out).toContain('value="https://ntfy.sh"');
    expect(out).toContain('Thema');
    expect(out).toContain('Token (optional)');
  });
});
