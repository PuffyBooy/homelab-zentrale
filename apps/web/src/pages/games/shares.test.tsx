import type { ShareLink } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  shareAuditKey,
  shareGatewayKey,
  sharesKey,
  type ShareAuditEntry,
  type ShareGatewaySettings,
} from '../../lib/shares.js';
import { game } from '../../test-fixtures.js';
import { ShareCreateDialog } from './ShareCreateDialog.js';
import { ShareAuditTile, ShareLinksTile } from './ShareLinksTile.js';

const now = new Date(2026, 10, 26, 23, 4);

function html(el: ReactElement, seed: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const gw = (over: Partial<ShareGatewaySettings> = {}): ShareGatewaySettings => ({
  enabled: false,
  publicUrl: null,
  tokenSet: false,
  lastSeenAt: null,
  ...over,
});

function link(over: Partial<ShareLink>): ShareLink {
  return {
    id: 'share-0001',
    gameId: 'game-0001',
    person: 'Max',
    perms: ['power'],
    hasPin: false,
    state: 'active',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lockedUntil: null,
    createdAt: '2026-11-26T20:00:00.000Z',
    ...over,
  };
}

describe('ShareLinksTile', () => {
  const g = game({ id: 'game-0001' });

  it('lists links with rights, state as shape and text, and the right action', () => {
    const out = html(<ShareLinksTile game={g} now={now} />, (qc) => {
      qc.setQueryData(sharesKey(g.id), [
        link({ id: 'share-aaaa', perms: ['power', 'console_read'], hasPin: true }),
        link({ id: 'share-bbbb', person: 'Lena', state: 'revoked' }),
      ]);
      qc.setQueryData(shareGatewayKey, gw());
    });
    expect(out).toContain('Benutzerlinks');
    expect(out).toContain('Starten/Stoppen · Konsole lesen');
    expect(out).toContain('läuft nie ab · mit PIN · noch nie benutzt');
    expect(out).toContain('hz-status hz-status-ok');
    expect(out).toContain('>AKTIV<');
    expect(out).toContain('hz-status hz-status-off');
    expect(out).toContain('>WIDERRUFEN<');
    expect(out).toContain('hz-btn-danger hz-btn-sm');
    expect(out).toContain('aria-label="Link von Lena entfernen"');
    // Active first.
    expect(out.indexOf('>Max<')).toBeLessThan(out.indexOf('>Lena<'));
    expect(out).toContain('Share-Gateway aus · Links gehen nur im Tailnet');
    expect(out).toContain('href="/settings#share-gateway"');
  });

  it('shows the empty state and the gateway when it is on', () => {
    const out = html(<ShareLinksTile game={g} now={now} />, (qc) => {
      qc.setQueryData(sharesKey(g.id), []);
      qc.setQueryData(shareGatewayKey, gw({ enabled: true, tokenSet: true }));
    });
    expect(out).toContain('Noch kein Link.');
    expect(out).toContain('Share-Gateway an');
  });
});

describe('ShareAuditTile', () => {
  const g = game({ id: 'game-0001' });
  const entry = (over: Partial<ShareAuditEntry>): ShareAuditEntry => ({
    id: 'audit-0001',
    shareId: 'share-0001',
    person: 'Max',
    action: 'start',
    detail: null,
    ts: new Date(2026, 10, 26, 23, 2).toISOString(),
    ip: null,
    via: 'tailnet',
    ...over,
  });

  it('says who did what, when and how', () => {
    const out = html(<ShareAuditTile game={g} now={now} />, (qc) =>
      qc.setQueryData(shareAuditKey(g.id), [
        entry({ id: 'audit-0002', action: 'console_write', detail: 'say hallo', via: 'gateway' }),
        entry({ id: 'audit-0003', action: 'denied' }),
        entry({}),
      ]),
    );
    expect(out).toContain('Wer hat was gemacht');
    expect(out).toContain('3 Einträge');
    expect(out).toContain('Max hat einen Befehl gesendet');
    expect(out).toContain('say hallo');
    expect(out).toContain('23:02 · über Gateway');
    expect(out).toContain('23:02 · im Tailnet');
    expect(out).toContain('>ABGEWIESEN<');
    expect(out).toContain('hz-status hz-status-warn');
  });
});

describe('ShareCreateDialog', () => {
  it('starts with Starten/Stoppen only and no console warning', () => {
    const out = html(
      <ShareCreateDialog game={game({ id: 'game-0001' })} onClose={() => {}} />,
      () => {},
    );
    expect(out).toContain('Konsole schreiben');
    expect(out).not.toContain('erlaubt jeden RCON-Befehl');
  });
});
