import { describe, expect, it } from 'vitest';
import { Tile } from './Tile.js';
import { countClass, html } from './test-utils.js';

describe('Tile', () => {
  it('renders head, count, status, body and footer', () => {
    const out = html(
      <Tile title="Server" icon="server" count="4" status="ok" footer="vor 4 s" span={2}>
        x
      </Tile>,
    );
    expect(out).toMatch(/^<section class="hz-tile hz-span-2">/);
    expect(out).toContain('<span>Server</span><span class="hz-tile-count">4</span>');
    expect(out).toContain('>UP<');
    expect(out).toContain('<div class="hz-tile-body">x</div>');
    expect(out).toContain('<footer class="hz-tile-foot">vor 4 s</footer>');
  });

  it('crit marks the tile and uses statusLabel', () => {
    const out = html(<Tile title="Oracle Cloud" status="crit" statusLabel="Nicht erreichbar" />);
    expect(out).toContain('class="hz-tile hz-tile-crit"');
    expect(out).toContain('>Nicht erreichbar<');
  });

  it('omits the head without title, status or actions', () => {
    const out = html(<Tile flush>body</Tile>);
    expect(out).toBe(
      '<section class="hz-tile hz-tile-flush"><div class="hz-tile-body">body</div></section>',
    );
    expect(countClass(out, 'hz-tile-head')).toBe(0);
  });
});
