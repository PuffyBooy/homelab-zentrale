import type { AppTemplateDetail, InstalledApp } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { emptyTemplateDraft } from '../../lib/apps.js';
import { server } from '../../test-fixtures.js';
import { CatalogTile } from './CatalogTile.js';
import { InstallForm } from './InstallDialog.js';
import { AppRow, RemoveForm } from './InstalledAppsTile.js';
import { TemplateForm } from './TemplatesTile.js';

const noop = (): void => undefined;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

function app(over: Partial<InstalledApp> = {}): InstalledApp {
  return {
    id: 'app-00000001',
    appId: 'vaultwarden',
    name: 'Vaultwarden',
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    templateId: 'vaultwarden',
    source: 'builtin',
    templateName: 'Vaultwarden',
    version: '1.32.5',
    bind: 'tailnet',
    ports: [{ port: 8081, protocol: 'tcp', label: 'Web' }],
    url: 'http://heimserver.tail1234.ts.net:8081',
    status: 'running',
    params: {},
    hasSecrets: true,
    containers: [{ name: 'vaultwarden', state: 'running', health: 'healthy' }],
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
    ...over,
  };
}

const tpl: AppTemplateDetail = {
  source: 'builtin',
  compose: 'services: {}',
  meta: {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Passwort-Manager, kompatibel mit Bitwarden',
    category: 'sicherheit',
    version: '1.32.5',
    arch: ['amd64'],
    minRamMb: 64,
    hints: ['Braucht HTTPS: hinter einem Reverse Proxy oder über tailscale serve.'],
    params: [
      {
        type: 'port',
        key: 'WEB_PORT',
        label: 'Web-Port',
        default: 8081,
        protocol: 'tcp',
        web: true,
      },
      { type: 'password', key: 'ADMIN_TOKEN', label: 'Admin-Token', generate: true, minLength: 12 },
      { type: 'bool', key: 'SIGNUPS', label: 'Registrierung offen', default: false },
    ],
  },
};

describe('catalog', () => {
  it('groups by category and opens the install dialog per card', () => {
    const out = html(
      <CatalogTile
        templates={[
          {
            id: 'jellyfin',
            source: 'builtin',
            name: 'Jellyfin',
            description: 'Filme und Serien',
            category: 'medien',
            version: '10.10.3',
            arch: ['amd64', 'arm64'],
            minRamMb: 512,
            installed: 1,
          },
          {
            id: 'mein-tool',
            source: 'custom',
            name: 'Mein Tool',
            description: 'Eigene Vorlage',
            category: 'werkzeuge',
            version: '1.0',
            arch: ['amd64'],
            minRamMb: 64,
            installed: 0,
          },
        ]}
        onPick={noop}
      />,
    );
    expect(out).toContain('type="search"');
    expect(out).toContain('<h3 class="hz-label app-catalog-head">Medien</h3>');
    expect(out).toContain('<h3 class="hz-label app-catalog-head">Werkzeuge</h3>');
    expect(out).toContain('10.10.3 · amd64, arm64 · ab 512 MB RAM');
    expect(out).toContain('1× installiert');
    expect(out).toContain('eigene');
    expect(out.indexOf('Medien')).toBeLessThan(out.indexOf('Werkzeuge'));
  });
});

describe('install dialog', () => {
  it('only fitting servers, tailnet by default, parameters per type, preview and install', () => {
    const out = html(
      <InstallForm
        templateId="vaultwarden"
        tpl={tpl}
        servers={[
          server({ id: 'srv-home0001', name: 'heimserver', arch: 'x64' }),
          server({ id: 'srv-pi000001', name: 'pi', arch: 'aarch64' }),
        ]}
        apps={[app()]}
        onClose={noop}
      />,
    );
    expect(out).toContain('<option value="srv-home0001" selected="">heimserver · amd64</option>');
    expect(out).toContain(
      '<option value="srv-pi000001" disabled="">pi · läuft nicht auf arm64</option>',
    );
    expect(out).toContain('value="vaultwarden-2"');
    expect(out).toContain('/opt/homelab/apps/vaultwarden-2/');
    expect(out).toContain('<option value="tailnet" selected="">Nur Tailnet (Standard)</option>');
    expect(out).toContain('Braucht HTTPS');
    expect(out).toMatch(/<input type="password"[^>]*autoComplete="new-password"/);
    expect(out).toContain('Leer lassen: die Zentrale erzeugt eins.');
    expect(out).toContain('aria-label="Registrierung offen"');
    expect(out).toContain('value="8081"');
    expect(out).toContain('>Vorschau<');
    expect(out).toContain('hz-btn-primary');
    expect(out).not.toContain('Ports offen für alle Netze.');
  });
});

describe('installed apps', () => {
  it('row: status with shape and text, ports, Öffnen, actions, passwords with code', () => {
    const out = html(<AppRow app={app()} />);
    expect(out).toContain('heimserver · Vaultwarden 1.32.5 · Tailnet · 8081/tcp Web');
    expect(out).toContain('hz-status hz-status-ok');
    expect(out).toContain('>läuft<');
    expect(out).toContain('href="http://heimserver.tail1234.ts.net:8081"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('aria-label="Vaultwarden stoppen"');
    expect(out).toContain('aria-label="Vaultwarden neu starten"');
    expect(out).toContain('aria-label="Vaultwarden aktualisieren"');
    expect(out).toContain('aria-label="Passwörter von Vaultwarden anzeigen (mit Code)"');
    expect(out).toContain('aria-label="Vaultwarden entfernen"');
    const stopped = html(<AppRow app={app({ status: 'stopped', url: null, hasSecrets: false })} />);
    expect(stopped).toContain('hz-status-off');
    expect(stopped).toContain('aria-label="Vaultwarden starten"');
    expect(stopped).not.toContain('Öffnen');
    expect(stopped).not.toContain('Passwörter');
    const broken = html(<AppRow app={app({ status: 'error', lastError: 'compose up: exit 1' })} />);
    expect(broken).toContain('hz-status-crit');
    expect(broken).toContain('Vaultwarden: compose up: exit 1');
  });

  it('remove: name typed again, data only when ticked, with a code', () => {
    const out = html(<RemoveForm app={app()} onClose={noop} />);
    expect(out).toContain('Ordnernamen <code>vaultwarden</code> eintippen');
    expect(out).toContain('aria-label="Daten löschen"');
    expect(out).toContain('aria-checked="false" aria-label="Daten löschen"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*class="hz-btn hz-btn-danger/);
    expect(out).toContain('Mit Code entfernen');
    expect(out).toContain('bleibt /opt/homelab/apps/vaultwarden/ liegen');
  });
});

describe('template editor', () => {
  it('metadata fields plus compose.yml in a text area', () => {
    const out = html(<TemplateForm initial={emptyTemplateDraft()} onClose={noop} />);
    expect(out).toContain('>Kennung</label>');
    expect(out).toContain('>Kategorie</label>');
    expect(out).toContain('aria-label="amd64"');
    expect(out).toContain('>Parameter (JSON)</label>');
    expect(out).toContain('>compose.yml</label>');
    expect(out).toMatch(/<textarea[^>]*class="hz-input app-textarea hz-input-mono"/);
    expect(out).toContain('${BIND}:${WEB_PORT}:80');
  });
});
