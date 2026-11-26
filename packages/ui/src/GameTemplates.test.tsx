import { describe, expect, it } from 'vitest';
import { GameTemplates } from './GameTemplates.js';
import { html } from './test-utils.js';

describe('GameTemplates', () => {
  it('renders one button per template and marks the selection', () => {
    const out = html(
      <GameTemplates
        selected="mc"
        templates={[
          {
            id: 'mc',
            name: 'Minecraft Java',
            image: 'itzg/minecraft-server',
            ram: '4–8 GB',
            port: 25565,
          },
          {
            id: 'cs2',
            name: 'Counter-Strike 2',
            image: 'joedwards32/cs2',
            ram: '8 GB',
            port: 27015,
            fits: false,
          },
        ]}
      />,
    );
    expect(out).toMatch(/^<div class="hz-tpl-grid">/);
    expect(out).toContain('class="hz-tpl hz-tpl-on"');
    expect(out.match(/type="button"/g)).toHaveLength(2);
    expect(out).toContain('<span>RAM 4–8 GB</span><span>:25565</span>');
    expect(out.match(/zu wenig RAM frei/g)).toHaveLength(1);
  });
});
