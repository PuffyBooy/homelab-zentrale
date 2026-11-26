import type { OnboardingCreateResponse, PortAuditResponse } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDisplayTimeZone } from '../../lib/format.js';
import { draftRow } from '../../lib/ports.js';
import { AllowPortButton } from '../alerts/AllowPortButton.js';
import { CodeStepView } from './EnrollDialog.js';
import { AllowedEditorView, OpenPortsView } from './OpenPortsTile.js';

const noop = (): void => undefined;
const NOW = new Date('2026-11-26T22:04:28.000Z');

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

const res: OnboardingCreateResponse = {
  id: 'onb_abcdefgh',
  name: 'pi-garage',
  code: 'ABCD-EFGH',
  expiresAt: '2026-11-26T22:19:00.000Z',
  oneLiner: 'curl -fsSL https://hub.tail1234.ts.net/install.sh | sudo sh -s -- ABCD-EFGH',
};

function step(
  state: 'waiting' | 'installing' | 'connected' | 'expired',
  serverId: string | null = null,
) {
  return html(
    <CodeStepView
      res={res}
      state={state}
      expiresAt={res.expiresAt}
      serverId={serverId}
      now={NOW}
      onCancel={noop}
      onClose={noop}
      onRenew={noop}
    />,
  );
}

describe('Server hinzufügen: code step', () => {
  it('waiting: big code, countdown, one-liner with copy, hint, Abbrechen', () => {
    const out = step('waiting');
    expect(out).toContain('data-state="waiting"');
    expect(out).toContain('Wartet auf den Server …');
    expect(out).toContain('hz-status-busy');
    expect(out).toContain('>ABCD-EFGH<');
    expect(out).toContain('noch 14:32 · gilt einmal, bis 23:19');
    expect(out).toContain('sudo sh -s -- ABCD-EFGH');
    expect(out).toContain('Kopieren');
    expect(out).toContain('Braucht Docker und Tailscale am neuen Server.');
    expect(out).toContain('>Abbrechen<');
    // No main action while waiting.
    expect(out).not.toContain('hz-btn-primary');
  });

  it('installing: no code any more', () => {
    const out = step('installing');
    expect(out).toContain('Installiert …');
    expect(out).not.toContain('ABCD-EFGH');
    expect(out).toContain('>Schließen<');
  });

  it('connected: Verbunden with a link to the server', () => {
    const out = step('connected', 'srv-000123');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('Verbunden');
    expect(out).toContain('href="/servers/srv-000123"');
    expect(out).toContain('Server öffnen');
  });

  it('expired: Abgelaufen and Neuen Code as the one main action', () => {
    const out = step('expired');
    expect(out).toContain('hz-status-off');
    expect(out).toContain('Abgelaufen');
    expect(out).toContain('um 23:19 abgelaufen');
    expect(out.match(/hz-btn-primary/g)).toHaveLength(1);
    expect(out).toContain('Neuen Code');
    expect(out).not.toContain('ABCD-EFGH');
  });
});

const audit: PortAuditResponse = {
  seeded: true,
  allowed: [{ port: 22, proto: 'tcp', note: 'ssh' }],
  open: [
    { proto: 'tcp', port: 22, addresses: ['0.0.0.0'], process: 'sshd', allowed: true },
    { proto: 'tcp', port: 8081, addresses: ['0.0.0.0', '::'], process: 'nginx', allowed: false },
  ],
};

describe('Offene Ports tile', () => {
  it('lists public ports with shape and text, Erlauben only for not allowed', () => {
    const out = html(
      <OpenPortsView serverName="heimserver" audit={audit} onAllow={noop} onEdit={noop} />,
    );
    expect(out).toContain('1 Port nicht erlaubt');
    expect(out).toContain('aria-label="Öffentliche Ports"');
    expect(out).toContain('8081/tcp');
    expect(out).toContain('nginx · 0.0.0.0, ::');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('nicht erlaubt');
    expect(out).toContain('aria-label="8081/tcp erlauben"');
    expect(out).not.toContain('aria-label="22/tcp erlauben"');
    expect(out).toContain('Erlaubt · 1 von 200');
    expect(out).toContain('aria-label="Erlaubte Ports"');
    expect(out).toContain('>ssh<');
  });

  it('not seeded yet: says where the list comes from', () => {
    const out = html(
      <OpenPortsView
        serverName="pi"
        audit={{ seeded: false, allowed: [], open: [] }}
        onAllow={noop}
        onEdit={noop}
      />,
    );
    expect(out).toContain('Soll-Liste kommt aus dem ersten Inventar');
    expect(out).toContain('keine offen');
  });

  it('editor: port, protocol, note per row and the 200 cap', () => {
    const row = { ...draftRow(), port: '8081', note: 'nginx' };
    const out = html(
      <AllowedEditorView
        rows={[row]}
        errors={{ [`${row.key}:port`]: '8081/tcp steht schon in der Liste.' }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(out).toContain('Erlaubt · 1 von 200');
    expect(out).toContain('>Port<');
    expect(out).toContain('>Protokoll<');
    expect(out).toContain('>Notiz<');
    expect(out).toContain('maxLength="80"');
    expect(out).toContain('8081/tcp steht schon in der Liste.');
    expect(out).toContain('aria-label="Port 8081 entfernen"');
    expect(out).toContain('Port hinzufügen');
    expect(out).not.toContain('hz-btn-primary');
  });
});

describe('Erlauben on alerts', () => {
  it('only for port alerts that are not resolved', () => {
    expect(
      html(
        <AllowPortButton
          alert={{ key: 'port:srv-000001:tcp:8081', state: 'open' }}
          onError={noop}
        />,
      ),
    ).toContain('aria-label="Port 8081/tcp erlauben"');
    expect(
      html(
        <AllowPortButton
          alert={{ key: 'port:srv-000001:tcp:8081', state: 'resolved' }}
          onError={noop}
        />,
      ),
    ).toBe('');
    expect(
      html(<AllowPortButton alert={{ key: 'server:x:1', state: 'open' }} onError={noop} />),
    ).toBe('');
  });
});
