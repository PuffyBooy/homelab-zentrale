import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDisplayTimeZone } from '../lib/format.js';
import { pageMeta } from '../shell/pageMeta.js';
import { server } from '../test-fixtures.js';
import { dns, fritz, guest, guests, monitor } from '../test-m14.js';
import { HeimnetzTile } from './network/HeimnetzTile.js';
import { DevicesTile, DnsFilterTile, InternetTile } from './network/NetworkTiles.js';
import { senderOptions } from './servers/WolTile.js';
import { GuestActionDialog } from './vms/GuestActionDialog.js';
import { VmsNotConfigured, VmsView } from './vms/VmsPage.js';
import { KumaView } from './websites/KumaTile.js';

const noop = (): void => undefined;
const NOW = new Date('2026-11-26T22:08:00.000Z');

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

describe('VMs page', () => {
  const data = guests([
    guest(),
    guest({ vmid: 102, name: 'db', status: 'stopped', type: 'lxc', uptimeS: null }),
    guest({ vmid: 9000, name: 'debian-tpl', status: 'stopped', template: true }),
  ]);

  it('lists guests with status shape and text, CPU, RAM bar and uptime', () => {
    const out = html(<VmsView data={data} now={NOW} onAction={noop} />);
    expect(out).toContain('1 von 2 laufen · 1 Vorlage');
    expect(out).toContain('101 · VM · pve');
    expect(out).toContain('102 · LXC · pve');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('hz-status-off');
    expect(out).toContain('>UP<');
    expect(out).toContain('CPU 12 % · 4 Kerne');
    expect(out).toContain('2 / 8 GB');
    expect(out).toContain('>3 T<');
    expect(out).toContain('aria-label="web01 herunterfahren"');
    expect(out).toContain('aria-label="web01 neu starten"');
    expect(out).toContain('aria-label="web01 stoppen"');
    expect(out).toContain('aria-label="db starten"');
    // Templates: label, no start button.
    expect(out).toContain('>Vorlage<');
    expect(out).not.toContain('aria-label="debian-tpl starten"');
    // Node summary.
    expect(out).toContain('Knoten');
    expect(out).toContain('12 / 32 GB · 38 %');
    // No main action on the list.
    expect(out).not.toContain('hz-btn-primary');
  });

  it('shows the error with a link to the settings and keeps the last list', () => {
    const out = html(
      <VmsView
        data={{ ...data, error: 'TLS-Fehler (Zertifikat prüfen)' }}
        now={NOW}
        onAction={noop}
      />,
    );
    expect(out).toContain('Proxmox nicht erreichbar: TLS-Fehler (Zertifikat prüfen)');
    expect(out).toContain('href="/settings#anbindung-proxmox"');
    expect(out).toContain('Stand von vor 4 Min');
    expect(out).toContain('web01');
  });

  it('marks the running action and disables the others', () => {
    const out = html(
      <VmsView
        data={data}
        now={NOW}
        pending={{ key: 'pve/102', action: 'start' }}
        onAction={noop}
      />,
    );
    expect(out).toContain('startet …');
    expect(out).toContain('hz-status-busy');
    expect(out).toMatch(/aria-label="web01 stoppen"[^>]*disabled/);
  });

  it('points to Einstellungen → Anbindungen when not set up', () => {
    const out = html(<VmsNotConfigured />);
    expect(out).toContain('Proxmox ist noch nicht eingerichtet.');
    expect(out).toContain('href="/settings#anbindung-proxmox"');
    expect(out).toContain('nicht eingerichtet');
  });

  it('confirms stop with a danger button and a hint about the code', () => {
    const out = html(
      <GuestActionDialog
        guest={guest()}
        action="stop"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(out).toContain('web01 hart stoppen?');
    expect(out).toContain('hz-btn-danger');
    expect(out).toContain('>Stoppen<');
    expect(out).toContain('frischer Code');
  });

  it('header: problems first', () => {
    const meta = pageMeta('/vms', {
      proxmox: guests([guest(), guest({ vmid: 103, name: 'old', status: 'paused' })]),
    });
    expect(meta.title).toEqual({ em: 'old ist pausiert', rest: ' · 1 von 2 Gästen läuft' });
    expect(meta.sub).toBe('VMs · 1 Knoten · 2 Gäste · alle 15 s aktualisiert');
    expect(meta.serverSwitch).toBe(false);
    const off = pageMeta('/vms', {
      modules: {
        github: true,
        homeassistant: true,
        games: true,
        proxmox: false,
        dnsfilter: false,
        fritzbox: false,
        uptimekuma: false,
        storage: true,
        logsearch: false,
        vulnscan: false,
        fail2ban: false,
        discordbot: false,
        voice: false,
        cloud: false,
      },
    });
    expect(off.title.rest).toBe('Proxmox ist ausgeschaltet.');
  });
});

describe('Netzwerk page', () => {
  it('Internet tile: status with shape and text, Mbit/s, uptime, IP, model', () => {
    const out = html(<InternetTile fritz={fritz()} now={NOW} onReboot={noop} />);
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('Internet verbunden');
    expect(out).toContain('>250<');
    expect(out).toContain('>40,5<');
    expect(out).toContain('Mbit/s');
    expect(out).toContain('2 T 1 h');
    expect(out).toContain('203.0.113.7');
    expect(out).toContain('>FRITZ!Box 7590 · FRITZ!OS 7.57<');
    expect(out).toContain('FRITZ!Box neu starten');
    expect(out).toContain('hz-btn-danger');
  });

  it('Internet tile: crit look while the line is down', () => {
    const f = fritz();
    if (f.internet) f.internet.connected = false;
    const out = html(<InternetTile fritz={f} now={NOW} onReboot={noop} />);
    expect(out).toContain('hz-tile-crit');
    expect(out).toContain('Internet getrennt');
    expect(out).toContain('hz-status-crit');
  });

  it('Geräte im Netz: active first, IP, LAN/WLAN, filter buttons', () => {
    const all = html(<DevicesTile fritz={fritz()} filter="all" onFilter={noop} />);
    expect(all).toContain('2 aktiv · 3 bekannt');
    expect(all.indexOf('heimserver')).toBeLessThan(all.indexOf('handy'));
    expect(all).toContain('192.168.178.40');
    expect(all).toContain('>LAN<');
    expect(all).toContain('>WLAN<');
    expect(all).toContain('aria-pressed="true"');
    const active = html(<DevicesTile fritz={fritz()} filter="active" onFilter={noop} />);
    expect(active).not.toContain('handy');
  });

  it('DNS-Filter tile: numbers, blocking state, pause buttons', () => {
    const out = html(<DnsFilterTile dns={dns()} now={NOW} busy={false} onBlocking={noop} />);
    expect(out).toContain('48.213');
    expect(out).toContain('4.050');
    expect(out).toContain('8,4 % der Anfragen');
    expect(out).toContain('1.204.311');
    expect(out).toContain('blockt');
    expect(out).toContain('5 Min pausieren');
    expect(out).toContain('aria-label="60 Min pausieren"');
    expect(out).not.toContain('Wieder blocken');
    const paused = html(
      <DnsFilterTile
        dns={dns({ blocking: false, pausedUntil: '2026-11-26T22:04:00.000Z' })}
        now={NOW}
        busy={false}
        onBlocking={noop}
      />,
    );
    expect(paused).toContain('pausiert bis 23:04');
    expect(paused).toContain('Wieder blocken');
    expect(paused).toContain('hz-status-warn');
    expect(paused).not.toContain('5 Min pausieren');
  });

  it('header: internet down comes first', () => {
    const f = fritz();
    if (f.internet) f.internet.connected = false;
    const meta = pageMeta('/network', { fritz: f, dns: dns() });
    expect(meta.title.em).toBe('Internet getrennt');
    expect(meta.sub).toBe('Netzwerk · 2 Geräte aktiv · Pi-hole · alle 15 s aktualisiert');
  });
});

describe('Heimnetz overview tile', () => {
  it('shows internet state and the blocked share', () => {
    const out = html(<HeimnetzTile fritz={fritz()} dns={dns()} fritzOn dnsOn />);
    expect(out).toContain('Internet verbunden');
    expect(out).toContain('>8,4<');
    expect(out).toContain('blockiert heute');
    expect(out).not.toContain('hz-tile-crit');
  });

  it('turns crit while the internet is down', () => {
    const f = fritz();
    if (f.internet) f.internet.connected = false;
    const out = html(<HeimnetzTile fritz={f} dns={dns()} fritzOn dnsOn />);
    expect(out).toContain('hz-tile-crit');
    expect(out).toContain('Internet getrennt');
  });
});

describe('Uptime Kuma on /websites', () => {
  const base = {
    servers: [server({ id: 'srv-home0001', name: 'heimserver' })],
    now: NOW,
    onToggle: noop,
    pingFrom: '',
    onPingFrom: noop,
    busy: false,
    error: null,
    onImport: noop,
  };
  const data = {
    monitors: [
      monitor(),
      monitor({
        name: 'nas',
        status: 'down',
        type: 'port',
        url: null,
        hostname: 'nas.lan',
        port: 445,
        importAs: 'tcp',
        certDaysRemaining: null,
        responseMs: null,
      }),
      monitor({ name: 'alt', checkId: 'chk_abcdefgh' }),
      monitor({
        name: 'router',
        type: 'ping',
        url: null,
        hostname: '192.168.178.1',
        importAs: 'ping',
      }),
      monitor({ name: 'docker', type: 'docker', url: null, importAs: null }),
    ],
    fetchedAt: '2026-11-26T22:07:00.000Z',
    error: null,
  };

  it('lists monitors with status, response time, cert days, import state', () => {
    const out = html(<KumaView {...base} data={data} selected={new Set()} result={null} />);
    expect(out).toContain('5 · 1 nicht erreichbar · 1 übernommen');
    expect(out.indexOf('nas')).toBeLessThan(out.indexOf('example.at'));
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('182 ms');
    expect(out).toContain('SSL 41d');
    expect(out).toContain('nas.lan:445');
    expect(out).toContain('übernommen');
    expect(out).toContain('Typ nicht unterstützt');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('example.at übernehmen');
    expect(out).not.toContain('alt übernehmen');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>.*Übernehmen/);
    // Secondary only: "Check anlegen" stays the one main action on /websites.
    expect(out).not.toContain('hz-btn-primary');
  });

  it('asks for a ping agent when a ping monitor is selected, shows the result', () => {
    const out = html(
      <KumaView
        {...base}
        data={data}
        selected={new Set(['router', 'example.at'])}
        result={{
          created: 1,
          skipped: [{ name: 'router', reason: 'Kein Agent für Ping gewählt' }],
        }}
      />,
    );
    expect(out).toContain('Ping-Checks laufen auf');
    expect(out).toContain('heimserver');
    expect(out).toContain('2 Monitore übernehmen');
    expect(out).toContain('1 Check angelegt · 1 übersprungen');
    expect(out).toContain('Kein Agent für Ping gewählt');
  });
});

describe('Wake-on-LAN sender', () => {
  it('offers the core and the other servers', () => {
    const opts = senderOptions(
      'srv-home0001',
      [
        server({ id: 'srv-home0001', name: 'heimserver' }),
        server({ id: 'srv-pi000001', name: 'pi', connected: false }),
      ],
      'core',
    );
    expect(opts).toEqual([
      { value: 'core', label: 'Zentrale' },
      { value: 'srv-pi000001', label: 'pi (offline)' },
    ]);
  });
});
