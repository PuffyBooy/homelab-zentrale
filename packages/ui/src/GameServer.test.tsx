import { describe, expect, it } from 'vitest';
import { GameServer } from './GameServer.js';
import { html } from './test-utils.js';

describe('GameServer', () => {
  it('renders a running server', () => {
    const out = html(
      <GameServer
        name="survival"
        game="Minecraft Paper"
        version="1.21.4"
        address="mc.hoebe.at"
        status="ok"
        players={[4, 20]}
        ram={72}
        ramDetail="5,8 / 8 GB"
        tps={19.8}
        online={['Alex', 'Lukas']}
        host="oracle-a1"
      />,
    );
    expect(out).toMatch(/^<section class="hz-tile hz-game">/);
    expect(out).toContain('>UP<');
    expect(out).toContain('<div class="hz-label">Minecraft Paper · 1.21.4</div>');
    expect(out).toContain('title="Adresse kopieren"');
    expect(out).toContain('<span class="hz-num">4</span><span class="hz-unit">/20</span>');
    expect(out).toContain('>5,8 / 8 GB<');
    expect(out).toContain('aria-label="TPS"');
    expect(out).toContain('aria-valuenow="99"');
    expect(out).toContain('<div class="hz-game-online"><span>Alex</span><span>Lukas</span></div>');
    expect(out).toContain('<span>Stop</span>');
    expect(out).not.toContain('hz-btn-primary');
    expect(out).toContain('<span class="hz-game-host">oracle-a1</span>');
  });

  it('offers Start as primary when off and handles missing TPS', () => {
    const out = html(
      <GameServer name="v" game="Valheim" address="a:2456" status="off" tps={null} host="h" />,
    );
    expect(out).toContain('>OFF<');
    expect(out).toContain('hz-btn hz-btn-primary hz-btn-sm');
    expect(out).toContain('<span>Start</span>');
    expect(out).toContain('<span class="hz-usage-val">—</span>');
    expect(out).toContain('<span class="hz-unit">/0</span>');
    expect(out).not.toContain('hz-game-online');
  });

  it('marks crit', () => {
    expect(html(<GameServer name="v" game="g" address="a" status="crit" host="h" />)).toContain(
      'class="hz-tile hz-game hz-tile-crit"',
    );
  });
});
