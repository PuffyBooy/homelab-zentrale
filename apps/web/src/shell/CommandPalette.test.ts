import type { HaItem, HaState } from '@hz/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onErrorToast, type LocalToast } from './AlertToasts.js';
import { haCommands } from './CommandPalette.js';

const item: HaItem = {
  entityId: 'light.wohnzimmer',
  kind: 'toggle',
  roomId: null,
  label: 'Licht Wohnzimmer',
  overview: true,
  state: 'off',
  value: null,
  unit: null,
  deviceClass: null,
  available: true,
  lastChanged: null,
  pending: false,
};
const state: HaState = {
  status: 'connected',
  error: null,
  rooms: [],
  items: [item],
  energy: null,
  updatedAt: '2026-11-26T22:04:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('palette HA commands', () => {
  it('a failed switch shows a short error toast instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error: 'ha_error',
              message: 'Home Assistant nicht erreichbar',
            }),
            { status: 502 },
          ),
        ),
      ),
    );
    const toasts: LocalToast[] = [];
    const off = onErrorToast((t) => toasts.push(t));
    try {
      const [cmd] = haCommands(new QueryClient(), state);
      expect(cmd?.label).toBe('Licht Wohnzimmer einschalten');
      cmd?.run?.();
      await vi.waitFor(() => expect(toasts).toHaveLength(1));
      expect(toasts[0]).toMatchObject({
        title: 'Licht Wohnzimmer nicht geschaltet',
        body: 'Home Assistant nicht erreichbar',
      });
    } finally {
      off();
    }
  });
});
