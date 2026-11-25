import { describe, expect, it } from 'vitest';
import { describeUserAgent, formatAgo, formatTime, retryMinutes } from './format.js';

describe('format', () => {
  it('uses 24 h time', () => {
    expect(formatTime(new Date(2026, 10, 25, 23, 4))).toBe('23:04');
  });

  it('says how long ago', () => {
    const now = new Date(2026, 10, 25, 23, 4);
    expect(formatAgo(new Date(now.getTime() - 20_000), now)).toBe('gerade eben');
    expect(formatAgo(new Date(now.getTime() - 4 * 60_000), now)).toBe('vor 4 Min');
    expect(formatAgo(new Date(now.getTime() - 2 * 3600_000), now)).toBe('vor 2 Std');
    expect(formatAgo(new Date(now.getTime() - 3 * 86400_000), now)).toBe('vor 3 Tagen');
  });

  it('rounds retry time up to whole minutes', () => {
    expect(retryMinutes(undefined)).toBe(1);
    expect(retryMinutes(30)).toBe(1);
    expect(retryMinutes(61)).toBe(2);
    expect(retryMinutes(900)).toBe(15);
  });

  it('names devices', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      ),
    ).toBe('Chrome · Linux');
    expect(describeUserAgent('')).toBe('Unbekanntes Gerät');
  });
});
