/*
 * Push handling for the service worker. Loaded by the generated Workbox worker via
 * importScripts (vite.config.ts, workbox.importScripts), so precaching stays as it is.
 * Plain script, no modules: it runs inside the service worker global scope.
 *
 * Payload: pushPayloadSchema from packages/shared/src/api/push.ts
 * ({ title, body, level, url, tag }). The text is the same as the alert.
 */

const HZ_LEVELS = ['ok', 'info', 'warn', 'crit'];
const HZ_FALLBACK_PATH = '/alerts';

/** Same rules as pushPayloadSchema. Returns null for anything else. */
function hzParsePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { title, body, level, url, tag } = raw;
  const keys = Object.keys(raw);
  if (keys.some((k) => !['title', 'body', 'level', 'url', 'tag'].includes(k))) return null;
  if (typeof title !== 'string' || title.length > 200) return null;
  if (typeof body !== 'string' || body.length > 1000) return null;
  if (!HZ_LEVELS.includes(level)) return null;
  if (typeof url !== 'string' || !url.startsWith('/') || url.length > 200) return null;
  if (typeof tag !== 'string' || tag.length > 200) return null;
  return { title, body, level, url, tag };
}

function hzHasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Only paths inside this app may be opened from a notification. Anything that would
 * leave the origin ("//evil", "/\\evil", "https://…", "javascript:") becomes /alerts.
 * Returns a path (pathname + search + hash) on `origin`.
 */
function hzSafePath(url, origin) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.length > 200) {
    return HZ_FALLBACK_PATH;
  }
  if (url.startsWith('//') || url.includes('\\') || hzHasControlChars(url)) {
    return HZ_FALLBACK_PATH;
  }
  let parsed;
  try {
    parsed = new URL(url, origin);
  } catch {
    return HZ_FALLBACK_PATH;
  }
  if (parsed.origin !== origin) return HZ_FALLBACK_PATH;
  return parsed.pathname + parsed.search + parsed.hash;
}

function hzReadPush(event) {
  if (!event.data) return null;
  try {
    return hzParsePayload(event.data.json());
  } catch {
    return null;
  }
}

/** Options for showNotification. crit stays until it is touched. */
function hzNotification(payload) {
  if (!payload) {
    // A push must always show something (userVisibleOnly).
    return {
      title: 'Homelab-Zentrale',
      options: {
        body: 'Neue Meldung. Details in der Zentrale unter Meldungen.',
        tag: 'hz-generic',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: HZ_FALLBACK_PATH },
      },
    };
  }
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.tag,
      // An OK for the same tag replaces the CRIT and should be noticed.
      renotify: !!payload.tag,
      requireInteraction: payload.level === 'crit',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url, level: payload.level },
    },
  };
}

async function hzOpen(path) {
  const origin = self.location.origin;
  const target = new URL(hzSafePath(path, origin), origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const same = windows.filter((c) => {
    try {
      return new URL(c.url).origin === origin;
    } catch {
      return false;
    }
  });
  const client = same.find((c) => c.focused) || same[0];
  if (client) {
    try {
      const focused = await client.focus();
      if (focused && 'navigate' in focused && focused.url !== target) {
        await focused.navigate(target);
      }
      return;
    } catch {
      // Not controlled by this worker: open a new window instead.
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener('push', (event) => {
  const n = hzNotification(hzReadPush(event));
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data && typeof data === 'object' ? data.url : undefined;
  event.waitUntil(hzOpen(url));
});
