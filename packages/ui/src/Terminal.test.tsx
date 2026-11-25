import { describe, expect, it } from 'vitest';
import { Terminal } from './Terminal.js';
import { html } from './test-utils.js';

describe('Terminal', () => {
  it('renders head, typed lines, prompt and cursor', () => {
    const out = html(
      <Terminal
        title="docker logs minecraft-paper"
        host="oracle-a1"
        lines={[{ kind: 'cmd', text: 'docker ps' }, { kind: 'err', text: 'boom' }, 'plain']}
      />,
    );
    expect(out).toContain(
      '<span>docker logs minecraft-paper</span><span class="hz-term-host">oracle-a1</span>',
    );
    expect(out).toContain(
      '<div class="hz-term-line hz-term-cmd"><span class="hz-term-prompt">$ </span>docker ps</div>',
    );
    expect(out).toContain('<div class="hz-term-line hz-term-err">boom</div>');
    expect(out).toContain('<div class="hz-term-line">plain</div>');
    expect(out).toContain('<span class="hz-term-cursor"></span>');
    expect(out).toContain('<pre class="hz-term-body">');
  });

  it('defaults the title, supports prompt, height and no cursor', () => {
    const out = html(
      <Terminal prompt="#" height={200} cursor={false} lines={[{ kind: 'cmd', text: 'ls' }]} />,
    );
    expect(out).toContain('<span>konsole</span>');
    expect(out).toContain('># <');
    expect(out).toContain('style="height:200px"');
    expect(out).not.toContain('hz-term-cursor');
    expect(out).not.toContain('hz-term-host');
  });
});
