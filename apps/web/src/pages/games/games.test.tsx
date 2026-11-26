import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { fieldDefaults } from '../../lib/games.js';
import { game, server, template } from '../../test-fixtures.js';
import { DeleteGameDialog } from './DeleteGameDialog.js';
import { ForwardHint } from './ForwardHint.js';
import { GamesTile } from './GamesTile.js';
import { GameTile } from './GameTile.js';
import { TemplateFields } from './TemplateFields.js';

function html(el: ReactElement): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

const noop = (): void => undefined;

describe('TemplateFields (form generator)', () => {
  const fields = template().fields;

  it('renders select, text, number and boolean with defaults', () => {
    const out = html(
      <TemplateFields fields={fields} draft={fieldDefaults(fields)} errors={{}} onChange={noop} />,
    );
    expect(out).toContain('class="hz-input hz-select"');
    expect(out).toMatch(/<option value="PAPER" selected="">PAPER<\/option>/);
    expect(out).toContain('<option value="FABRIC">FABRIC</option>');
    expect(out).toContain('value="LATEST"');
    expect(out).toContain('inputMode="decimal"');
    expect(out).toContain('value="20"');
    expect(out).toContain('1 bis 100');
    expect(out).toContain('>optional<');
    expect(out).toContain('role="switch" aria-checked="true" aria-label="Whitelist"');
  });

  it('shows errors on the field and marks it invalid', () => {
    const out = html(
      <TemplateFields
        fields={fields}
        draft={{ ...fieldDefaults(fields), MAX_PLAYERS: '0' }}
        errors={{ MAX_PLAYERS: 'Zahl von 1 bis 100.' }}
        onChange={noop}
      />,
    );
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('<span class="hz-field-error"');
    expect(out).toContain('Zahl von 1 bis 100.');
  });

  it('uses a password input for secret fields', () => {
    const f = [
      { key: 'SERVER_PASS', label: 'Passwort', type: 'text' as const, default: '', secret: true },
    ];
    expect(html(<TemplateFields fields={f} draft={{}} errors={{}} onChange={noop} />)).toContain(
      'type="password"',
    );
  });
});

describe('GameTile', () => {
  it('shows status shape and tag, formatted values and an enabled Teilen', () => {
    const out = html(<GameTile game={game()} onConsole={noop} />);
    expect(out).toContain('hz-status hz-status-ok');
    expect(out).toContain('>UP<');
    expect(out).toContain('title="Adresse kopieren"');
    expect(out).toContain('<span>mc.example.org:25565</span>');
    expect(out).toContain('>5,8 / 8 GB<');
    expect(out).toContain('>19,8<');
    expect(out).not.toContain('disabled=""');
    expect(out).toContain('<span>Teilen</span>');
    expect(out).toContain('aria-live="polite"');
  });

  it('offers Start when stopped and blocks actions while busy', () => {
    expect(html(<GameTile game={game({ status: 'off' })} onConsole={noop} />)).toContain(
      'hz-btn-primary',
    );
    const busy = html(<GameTile game={game({ status: 'busy' })} onConsole={noop} />);
    expect(busy).toContain('>BOOT<');
    // Stop and Restart wait; Konsole and Teilen stay usable.
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('GamesTile (overview)', () => {
  it('shows running games as tiles, problems first, at most two', () => {
    const out = html(
      <GamesTile
        games={[
          game({ name: 'a' }),
          game({ name: 'b', status: 'crit', statusText: 'abgestürzt' }),
          game({ name: 'c' }),
          game({ name: 'd', status: 'off' }),
        ]}
      />,
    );
    expect(out.indexOf('<span>b</span>')).toBeLessThan(out.indexOf('<span>a</span>'));
    expect(out).not.toContain('<span>c</span>');
    expect(out).toContain('+2 weitere · alle Gameserver');
  });

  it('says so when everything is stopped or nothing exists', () => {
    expect(html(<GamesTile games={[game({ status: 'off' })]} />)).toContain(
      'Der Gameserver ist gestoppt.',
    );
    expect(html(<GamesTile games={[]} />)).toContain('Noch keine Gameserver.');
  });
});

describe('DeleteGameDialog', () => {
  it('asks for the name and keeps Löschen disabled until it matches', () => {
    const out = html(<DeleteGameDialog game={game()} onClose={noop} />);
    expect(out).toContain('survival löschen');
    expect(out).toContain('Die Zentrale sichert zuerst die Welt');
    expect(out).toContain('placeholder="survival"');
    expect(out).toContain(
      '<button disabled="" class="hz-btn hz-btn-danger hz-btn-md" type="submit">',
    );
  });
});

describe('ForwardHint', () => {
  const ports = [{ name: 'game', port: 2456, protocol: 'udp' as const, count: 3 }];

  it('shows the exact ports and the Oracle security list for oracle servers', () => {
    const out = html(<ForwardHint ports={ports} server={server({ name: 'oracle-a1' })} />);
    expect(out).toContain('2456–2458/UDP');
    expect(out).toContain('Security List');
    expect(out).not.toContain('Zuhause (Router)');
  });

  it('shows the home router at home and both without a guess', () => {
    const home = html(<ForwardHint ports={ports} server={server({ name: 'heimserver' })} />);
    expect(home).toContain('Zuhause (Router)');
    expect(home).not.toContain('Security List');
    const both = html(<ForwardHint ports={ports} server={undefined} />);
    expect(both).toContain('Zuhause (Router)');
    expect(both).toContain('Security List');
  });
});
