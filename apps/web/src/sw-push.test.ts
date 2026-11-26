import { describe, expect, it, vi } from 'vitest';
import source from '../public/sw-push.js?raw';

/**
 * Runs public/sw-push.js the way the service worker does (a classic script with `self`)
 * and drives its `push` and `notificationclick` listeners with fake events.
 */

const ORIGIN = 'https://zentrale.tail1234.ts.net';

interface FakeClient {
  url: string;
  focused: boolean;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

type Listener = (event: Record<string, unknown>) => void;

function load(windows: FakeClient[] = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(() => Promise.resolve());
  const openWindow = vi.fn(() => Promise.resolve(null));
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { showNotification },
    clients: { matchAll: vi.fn(() => Promise.resolve(windows)), openWindow },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
  };
  // Same as importScripts: the script sees `self`; its top-level helper is returned for tests.
  const run = new Function('self', `${source}\nreturn { hzSafePath };`) as (s: unknown) => {
    hzSafePath: (url: unknown, origin: string) => string;
  };
  const safePath = run(self).hzSafePath;

  async function fire(type: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  return { safePath, fire, showNotification, openWindow };
}

function pushEvent(data: unknown) {
  return {
    data:
      data === undefined
        ? null
        : {
            json: () => {
              if (typeof data === 'string') return JSON.parse(data) as unknown;
              return data;
            },
          },
  };
}

function client(url: string, focused = false): FakeClient {
  const c: FakeClient = {
    url,
    focused,
    focus: vi.fn(() => Promise.resolve(c)),
    navigate: vi.fn(() => Promise.resolve(c)),
  };
  return c;
}

describe('hzSafePath (notificationclick never leaves the app)', () => {
  const { safePath } = load();

  it('keeps same-origin paths', () => {
    expect(safePath('/alerts', ORIGIN)).toBe('/alerts');
    expect(safePath('/websites/chk-000001?x=1#top', ORIGIN)).toBe('/websites/chk-000001?x=1#top');
    expect(safePath('/servers/../alerts', ORIGIN)).toBe('/alerts');
  });

  it.each([
    'https://evil.example/phish',
    'http://evil.example',
    '//evil.example/x',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'data:text/html,hi',
    ' /alerts',
    '/al\nerts',
    '/\t/evil.example',
    `${ORIGIN}/alerts`,
    '',
    null,
    42,
    `/${'a'.repeat(250)}`,
  ])('maps %j to /alerts', (url) => {
    expect(safePath(url, ORIGIN)).toBe('/alerts');
  });
});

describe('push event', () => {
  it('shows the alert text with tag and url', async () => {
    const sw = load();
    await sw.fire(
      'push',
      pushEvent({
        title: 'lernen.example.org ist offline',
        body: 'Seit 23:02 HTTP 503. Container lernplattform prüfen.',
        level: 'crit',
        url: '/websites/chk-000001',
        tag: 'check:chk-000001:down',
      }),
    );
    expect(sw.showNotification).toHaveBeenCalledWith('lernen.example.org ist offline', {
      body: 'Seit 23:02 HTTP 503. Container lernplattform prüfen.',
      tag: 'check:chk-000001:down',
      renotify: true,
      requireInteraction: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/websites/chk-000001', level: 'crit' },
    });
  });

  it.each([
    ['no data', undefined],
    ['not JSON', 'nope{'],
    ['external url', { title: 't', body: 'b', level: 'crit', url: 'https://x.y', tag: 't' }],
    ['unknown level', { title: 't', body: 'b', level: 'boom', url: '/', tag: 't' }],
    ['extra field', { title: 't', body: 'b', level: 'ok', url: '/', tag: 't', icon: 'x' }],
  ])('falls back to a generic notification for %s', async (_name, data) => {
    const sw = load();
    await sw.fire('push', pushEvent(data));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = sw.showNotification.mock.calls[0] as unknown as [
      string,
      { data: { url: string } },
    ];
    expect(title).toBe('Homelab-Zentrale');
    expect(opts.data.url).toBe('/alerts');
  });
});

describe('notificationclick', () => {
  function clickEvent(url: unknown) {
    return { notification: { close: vi.fn(), data: { url } } };
  }

  it('focuses an open window and navigates it', async () => {
    const win = client(`${ORIGIN}/`, true);
    const sw = load([client('https://other.example/'), win]);
    const ev = clickEvent('/websites');
    await sw.fire('notificationclick', ev);
    expect(ev.notification.close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.navigate).toHaveBeenCalledWith(`${ORIGIN}/websites`);
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window inside the app when none is open', async () => {
    const sw = load([]);
    await sw.fire('notificationclick', clickEvent('/alerts'));
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/alerts`);
  });

  it('never opens an external url', async () => {
    const sw = load([]);
    await sw.fire('notificationclick', clickEvent('https://evil.example/'));
    await sw.fire('notificationclick', clickEvent('//evil.example/'));
    expect(sw.openWindow.mock.calls).toEqual([[`${ORIGIN}/alerts`], [`${ORIGIN}/alerts`]]);
  });

  it('falls back to openWindow when the window cannot be navigated', async () => {
    const win = client(`${ORIGIN}/servers`);
    win.navigate.mockRejectedValueOnce(new TypeError('not controlled'));
    const sw = load([win]);
    await sw.fire('notificationclick', clickEvent('/alerts'));
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/alerts`);
  });
});
