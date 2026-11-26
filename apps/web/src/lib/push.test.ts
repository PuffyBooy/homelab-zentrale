import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  normalizeTime,
  notifyAnswer,
  notifyFormToPatch,
  notifyToForm,
  pushSupport,
} from './push.js';

const env = {
  isSecureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  permission: 'default' as NotificationPermission | null,
};

describe('pushSupport', () => {
  it('needs HTTPS, a service worker, PushManager and Notification', () => {
    expect(pushSupport(env)).toBe('default');
    expect(pushSupport({ ...env, permission: 'granted' })).toBe('granted');
    expect(pushSupport({ ...env, permission: 'denied' })).toBe('denied');
    expect(pushSupport({ ...env, isSecureContext: false })).toBe('insecure');
    expect(pushSupport({ ...env, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...env, permission: null })).toBe('unsupported');
  });
});

describe('base64UrlToBytes', () => {
  it('decodes base64url without padding', () => {
    expect([...base64UrlToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
    expect(base64UrlToBytes('').length).toBe(0);
  });
});

describe('notify settings form', () => {
  const settings = {
    quietStart: '23:00',
    quietEnd: '07:00',
    warnBundleMinutes: 30,
    weeklyReport: true,
  };

  it('validates the settings answer', () => {
    expect(notifyAnswer.parse(settings)).toEqual(settings);
    expect(() => notifyAnswer.parse({ quietStart: '25:00' })).toThrow();
  });

  it('normalizes times and validates', () => {
    expect(normalizeTime('7')).toBe('07:00');
    expect(normalizeTime('7:30')).toBe('07:30');
    expect(normalizeTime('22.15')).toBe('22:15');
    const form = { ...notifyToForm(settings), quietEnd: '6', warnBundleMinutes: '60' };
    expect(notifyFormToPatch(form)).toEqual({
      ok: true,
      patch: { quietStart: '23:00', quietEnd: '06:00', warnBundleMinutes: 60, weeklyReport: true },
    });
    const bad = notifyFormToPatch({ ...form, quietStart: '24:00', warnBundleMinutes: '2' });
    expect(bad).toEqual({
      ok: false,
      errors: {
        quietStart: 'Uhrzeit als HH:MM, z. B. 23:00.',
        warnBundleMinutes: 'Zwischen 5 und 240 Min.',
      },
    });
  });
});
