import {
  notifySettingsSchema,
  okResponseSchema,
  pushDeviceListResponseSchema,
  pushDeviceSchema,
  pushSubscriptionSchema,
  pushTestResponseSchema,
  vapidResponseSchema,
  type NotifySettings,
  type PushSubscriptionJson,
} from '@hz/shared';
import { api, type Schema } from './api.js';

export const vapidKey = ['push', 'vapid'] as const;
export const pushDevicesKey = ['push', 'devices'] as const;
export const notifySettingsKey = ['settings', 'notify'] as const;

/** Id of the subscription created on this device (to mark "dieses Gerät"). */
const DEVICE_ID_KEY = 'hz-push-device';

export async function fetchVapidKey(signal?: AbortSignal): Promise<string | null> {
  const res = await api('/api/push/vapid', { schema: vapidResponseSchema, signal });
  return res.publicKey;
}

export async function fetchPushDevices(signal?: AbortSignal) {
  const res = await api('/api/push/subscriptions', {
    schema: pushDeviceListResponseSchema,
    signal,
  });
  return res.devices;
}

/**
 * POST /api/push/subscriptions. The schemas leave the answer open; the id is taken
 * from `{ device: {...} }` or `{ id }` if present, otherwise it stays unknown.
 */
const subscribeAnswer: Schema<{ id: string | null }> = {
  parse(data: unknown) {
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const dev = pushDeviceSchema.safeParse(d.device);
      if (dev.success) return { id: dev.data.id };
      if (typeof d.id === 'string') return { id: d.id };
    }
    return { id: null };
  },
};

export function postSubscription(
  subscription: PushSubscriptionJson,
  label: string,
): Promise<{ id: string | null }> {
  return api('/api/push/subscriptions', {
    method: 'POST',
    body: { subscription, label },
    schema: subscribeAnswer,
  });
}

export async function deletePushDevice(id: string): Promise<void> {
  await api(`/api/push/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  });
}

export async function sendTestPush(): Promise<number> {
  const res = await api('/api/push/test', {
    method: 'POST',
    body: {},
    schema: pushTestResponseSchema,
  });
  return res.sent;
}

/** Accepts the settings bare or as `{ settings: {...} }`. */
export const notifyAnswer: Schema<NotifySettings> = {
  parse(data: unknown) {
    const inner =
      data && typeof data === 'object' && 'settings' in data
        ? (data as { settings: unknown }).settings
        : data;
    return notifySettingsSchema.parse(inner);
  },
};

export function fetchNotifySettings(signal?: AbortSignal): Promise<NotifySettings> {
  return api('/api/settings/notify', { schema: notifyAnswer, signal });
}

export function patchNotifySettings(patch: Partial<NotifySettings>): Promise<NotifySettings> {
  return api('/api/settings/notify', { method: 'PATCH', body: patch, schema: notifyAnswer });
}

// ---------------------------------------------------------------------------
// Browser side

/** VAPID public key (base64url) -> bytes for pushManager.subscribe. */
export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSupport = 'unsupported' | 'insecure' | 'denied' | 'default' | 'granted';

export interface PushEnv {
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  permission: NotificationPermission | null;
}

export function browserPushEnv(): PushEnv {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    isSecureContext: !!w?.isSecureContext,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: !!w && 'PushManager' in w,
    permission: w && 'Notification' in w ? Notification.permission : null,
  };
}

/** What this device can do. Pure, unit tested. */
export function pushSupport(env: PushEnv): PushSupport {
  if (!env.isSecureContext) return 'insecure';
  if (!env.hasServiceWorker || !env.hasPushManager || env.permission === null) {
    return 'unsupported';
  }
  return env.permission;
}

export const SUPPORT_TEXT: Record<Exclude<PushSupport, 'granted' | 'default'>, string> = {
  insecure: 'Push braucht HTTPS. Die Zentrale über die tailscale-serve-Adresse (*.ts.net) öffnen.',
  unsupported:
    'Dieser Browser kann keine Push-Nachrichten. Am iPhone die Zentrale erst zum Home-Bildschirm hinzufügen und von dort öffnen.',
  denied:
    'Benachrichtigungen sind für die Zentrale blockiert. In den Browser-Einstellungen erlauben und die Seite neu laden.',
};

export class PushSetupError extends Error {
  constructor(readonly reason: 'denied' | 'no_worker' | 'no_key' | 'bad_subscription') {
    super(`push setup: ${reason}`);
    this.name = 'PushSetupError';
  }
}

export const PUSH_ERROR_TEXT: Record<PushSetupError['reason'], string> = {
  denied: 'Benachrichtigungen nicht erlaubt. Ohne Erlaubnis kommt keine Push an.',
  no_worker:
    'Service Worker nicht aktiv. Die Zentrale einmal neu laden (im Entwicklungsmodus gibt es keinen).',
  no_key: 'Push ist in der Zentrale nicht eingerichtet: kein VAPID-Schlüssel.',
  bad_subscription: 'Der Browser hat ein ungültiges Push-Abo geliefert. Erneut versuchen.',
};

const WORKER_WAIT_MS = 10_000;

function readyWorker(): Promise<ServiceWorkerRegistration> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PushSetupError('no_worker')), WORKER_WAIT_MS);
    navigator.serviceWorker.ready.then(
      (reg) => {
        clearTimeout(t);
        resolve(reg);
      },
      () => {
        clearTimeout(t);
        reject(new PushSetupError('no_worker'));
      },
    );
  });
}

/** Asks for permission, subscribes with the VAPID key and registers the device in the core. */
export async function enablePushOnThisDevice(publicKey: string | null, label: string) {
  if (!publicKey) throw new PushSetupError('no_key');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushSetupError('denied');
  const reg = await readyWorker();
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    // Subscribed with an old VAPID key: the core could not send to it.
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const parsed = pushSubscriptionSchema.safeParse(sub.toJSON());
  if (!parsed.success) throw new PushSetupError('bad_subscription');
  const res = await postSubscription(parsed.data, label);
  if (res.id) rememberDevice(res.id);
  return res;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Ends the browser subscription (after the device was removed in the core). */
export async function disablePushOnThisDevice(): Promise<void> {
  forgetDevice();
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
}

export function thisDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

function rememberDevice(id: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Private mode: the device is just not marked.
  }
}

function forgetDevice(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Notify settings form

export interface NotifyForm {
  quietStart: string;
  quietEnd: string;
  warnBundleMinutes: string;
  weeklyReport: boolean;
}

export function notifyToForm(s: NotifySettings): NotifyForm {
  return { ...s, warnBundleMinutes: String(s.warnBundleMinutes) };
}

export type NotifyErrors = Partial<Record<keyof NotifyForm, string>>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "7:00" -> "07:00", "7" -> "07:00". Anything else stays as typed. */
export function normalizeTime(s: string): string {
  const t = s.trim().replace('.', ':');
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m) return t;
  return `${(m[1] ?? '').padStart(2, '0')}:${m[2] ?? '00'}`;
}

export function notifyFormToPatch(
  f: NotifyForm,
): { ok: true; patch: NotifySettings } | { ok: false; errors: NotifyErrors } {
  const errors: NotifyErrors = {};
  const quietStart = normalizeTime(f.quietStart);
  const quietEnd = normalizeTime(f.quietEnd);
  if (!HHMM.test(quietStart)) errors.quietStart = 'Uhrzeit als HH:MM, z. B. 23:00.';
  if (!HHMM.test(quietEnd)) errors.quietEnd = 'Uhrzeit als HH:MM, z. B. 07:00.';
  const n = /^\d+$/.test(f.warnBundleMinutes.trim()) ? Number(f.warnBundleMinutes.trim()) : NaN;
  if (!(n >= 5 && n <= 240)) errors.warnBundleMinutes = 'Zwischen 5 und 240 Min.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    patch: { quietStart, quietEnd, warnBundleMinutes: n, weeklyReport: f.weeklyReport },
  };
}
