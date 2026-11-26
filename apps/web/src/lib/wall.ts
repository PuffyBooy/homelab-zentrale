import {
  okResponseSchema,
  wallDeviceCreateResponseSchema,
  wallDeviceListResponseSchema,
  wallStateSchema,
  wallTokenSchema,
  type WallState,
} from '@hz/shared';
import { api } from './api.js';

/** Wall mode (SPEC 12). Only these two calls run on /wall; no admin data. */

export const wallStateKey = ['wall', 'state'] as const;
export const wallDevicesKey = ['settings', 'wall-devices'] as const;

export type WallDevice = ReturnType<typeof wallDeviceListResponseSchema.parse>['devices'][number];
export type WallDeviceCreated = ReturnType<typeof wallDeviceCreateResponseSchema.parse>;

export function fetchWallState(signal?: AbortSignal): Promise<WallState> {
  return api('/api/wall/state', { schema: wallStateSchema, signal, quiet401: true, stepUp: false });
}

/** Swaps the device token from the link for the httpOnly `hz_wall` cookie. */
export async function startWallSession(token: string): Promise<void> {
  await api('/api/wall/session', {
    method: 'POST',
    body: { token },
    schema: okResponseSchema,
    quiet401: true,
    stepUp: false,
  });
}

/** Device token from `?t=`, only if it has the right shape. */
export function wallTokenFrom(search: string): string | null {
  const t = new URLSearchParams(search).get('t');
  return t && wallTokenSchema.safeParse(t).success ? t : null;
}

export function hasTokenParam(search: string): boolean {
  return new URLSearchParams(search).has('t');
}

export async function fetchWallDevices(signal?: AbortSignal): Promise<WallDevice[]> {
  const res = await api('/api/settings/wall-devices', {
    schema: wallDeviceListResponseSchema,
    signal,
  });
  return res.devices;
}

export function createWallDevice(name: string): Promise<WallDeviceCreated> {
  return api('/api/settings/wall-devices', {
    method: 'POST',
    body: { name: name.trim() },
    schema: wallDeviceCreateResponseSchema,
  });
}

export async function deleteWallDevice(id: string): Promise<void> {
  await api(`/api/settings/wall-devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  });
}

/** Problems first (crit, warn), then the fixed order of the core. */
export function sortWallTiles<T extends { tone: WallState['tiles'][number]['tone'] }>(
  tiles: readonly T[],
): T[] {
  const rank = { crit: 0, warn: 1, ok: 2, off: 2 } as const;
  return tiles
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank[a.t.tone] - rank[b.t.tone] || a.i - b.i)
    .map((x) => x.t);
}
