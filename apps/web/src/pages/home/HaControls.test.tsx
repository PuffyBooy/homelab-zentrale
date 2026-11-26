import type { HaItem, HaState } from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HaControl } from './HaControls.js';

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

function item(over: Partial<HaItem>): HaItem {
  return {
    entityId: 'light.wohnzimmer',
    kind: 'toggle',
    roomId: null,
    label: 'Licht Wohnzimmer',
    overview: true,
    state: 'on',
    value: null,
    unit: null,
    deviceClass: null,
    available: true,
    lastChanged: null,
    pending: false,
    ...over,
  };
}

function state(status: HaState['status'] = 'connected'): HaState {
  return {
    status,
    error: null,
    rooms: [],
    items: [],
    energy: null,
    updatedAt: '2026-11-26T22:04:00.000Z',
  };
}

const noop = (): void => undefined;

describe('HaControl', () => {
  it('renders a toggle as an AN/AUS switch', () => {
    const out = html(<HaControl state={state()} item={item({})} onToggle={noop} />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Licht Wohnzimmer"');
    expect(out).not.toContain('disabled');
  });

  it('greys toggles out while HA is unreachable', () => {
    const out = html(<HaControl state={state('unreachable')} item={item({})} onToggle={noop} />);
    expect(out).toContain('hz-toggle-disabled');
    expect(out).toContain('Home Assistant nicht erreichbar');
  });

  it('renders a sensor as Metric with unit', () => {
    const out = html(
      <HaControl
        state={state()}
        item={item({
          entityId: 'sensor.temp',
          kind: 'metric',
          label: 'Temperatur',
          value: 21.43,
          unit: '°C',
          state: '21.43',
        })}
        onToggle={noop}
      />,
    );
    expect(out).toContain('class="hz-metric"');
    expect(out).toContain('>21,4<');
    expect(out).toContain('>°C<');
  });

  it('renders a door opener as a Button, never as a switch', () => {
    const out = html(
      <HaControl
        state={state()}
        item={item({ entityId: 'lock.front_door', kind: 'button', label: 'Haustür' })}
        onToggle={noop}
      />,
    );
    expect(out).not.toContain('role="switch"');
    expect(out).toContain('hz-btn');
    expect(out).toContain('>Tür öffnen<');
    expect(out).toContain('nur mit Bestätigung');
    // The confirm dialog only opens on click.
    expect(out).not.toContain('<dialog');
  });
});
