import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GameServer } from './GameServer.js';
import { html } from './test-utils.js';

describe('GameServer', () => {
  it('renders a running server', () => {
    const out = html(
      <GameServer
        name="survival"
        game="Minecraft Paper"
        version="1.21.4"
        address="mc.example.org"
        status="ok"
        players={[4, 20]}
        ram={72}
        ramDetail="5,8 / 8 GB"
        tps={19.8}
        online={['Sam', 'Lukas']}
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
    expect(out).toContain('<div class="hz-game-online"><span>Sam</span><span>Lukas</span></div>');
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

type AnyEl = ReactElement<Record<string, unknown>>;

/** Elements of the (unrendered) tree returned by GameServer(), depth first. */
function walk(node: unknown, out: AnyEl[] = []): AnyEl[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (isValidElement(node)) {
    const el = node as AnyEl;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}

describe('GameServer additions (handlers, formatted TPS)', () => {
  const base = {
    name: 'survival',
    game: 'Minecraft Paper',
    address: 'mc.example.org:25565',
    host: 'h',
  };

  it('copies the address on click and reports it', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopy = vi.fn();
    const tree = walk(GameServer({ ...base, onCopy }));
    const addr = tree.find((e) => e.props.className === 'hz-addr');
    expect(addr).toBeDefined();
    (addr?.props.onClick as () => void)();
    expect(writeText).toHaveBeenCalledWith('mc.example.org:25565');
    expect(onCopy).toHaveBeenCalledWith('mc.example.org:25565');
    vi.unstubAllGlobals();
  });

  it('wires the footer buttons to the handlers', () => {
    const on = { onStop: vi.fn(), onRestart: vi.fn(), onConsole: vi.fn(), onShare: vi.fn() };
    const tree = walk(GameServer({ ...base, status: 'ok', ...on }));
    const byIcon = (icon: string): AnyEl | undefined => tree.find((e) => e.props.icon === icon);
    (byIcon('stop')?.props.onClick as () => void)();
    (byIcon('refresh')?.props.onClick as () => void)();
    (byIcon('terminal')?.props.onClick as () => void)();
    (byIcon('link')?.props.onClick as () => void)();
    expect(on.onStop).toHaveBeenCalledOnce();
    expect(on.onRestart).toHaveBeenCalledOnce();
    expect(on.onConsole).toHaveBeenCalledOnce();
    expect(on.onShare).toHaveBeenCalledOnce();
    const onStart = vi.fn();
    const off = walk(GameServer({ ...base, status: 'off', onStart }));
    (off.find((e) => e.props.icon === 'play')?.props.onClick as () => void)();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('disables listed actions and keeps the reference markup without them', () => {
    const out = html(<GameServer {...base} disabledActions={['share', 'restart']} />);
    expect(out.match(/disabled=""/g)).toHaveLength(2);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*><svg[^>]*>.*?<\/svg><span>Restart<\/span>/);
    expect(html(<GameServer {...base} />)).not.toContain('disabled');
  });

  it('shows the formatted TPS when given', () => {
    expect(html(<GameServer {...base} tps={19.8} tpsDetail="19,8" />)).toContain(
      '<span class="hz-usage-val">19,8</span>',
    );
    expect(html(<GameServer {...base} tps={null} tpsDetail="x" />)).toContain(
      '<span class="hz-usage-val">—</span>',
    );
  });

  it('shows an own status text with the off shape (sleeping)', () => {
    const out = html(<GameServer {...base} status="off" statusLabel="Schläft" />);
    expect(out).toContain('hz-status-off');
    expect(out).toContain('>Schläft<');
    expect(out).not.toContain('>OFF<');
    expect(html(<GameServer {...base} status="off" />)).toContain('>OFF<');
  });
});
