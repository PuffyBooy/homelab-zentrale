import { describe, expect, it } from 'vitest';
import {
  describeUserAgent,
  formatAgo,
  formatBytes,
  formatBytesOf,
  formatNumber,
  formatPercent,
  formatRate,
  formatTemp,
  formatTime,
  formatUptime,
  formatUptimeShort,
  formatWhen,
  plural,
  retryMinutes,
} from './format.js';

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

  it('formats numbers the Austrian way', () => {
    expect(formatNumber(7.83)).toBe('7,8');
    expect(formatNumber(12345.6, 0)).toBe('12346');
    expect(formatNumber(-0.01)).toBe('0');
    expect(formatPercent(23.4)).toBe('23 %');
    expect(formatPercent(null)).toBe('—');
    expect(formatTemp(21.44)).toBe('21,4 °C');
    expect(formatTemp(60)).toBe('60 °C');
  });

  it('formats bytes with a space before the unit', () => {
    const GB = 1024 ** 3;
    expect(formatBytes(7.8 * GB)).toBe('7,8 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(480 * GB)).toBe('480 GB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytesOf(5.8 * GB, 8 * GB)).toBe('5,8 / 8 GB');
    expect(formatBytesOf(389 * GB, 480 * GB)).toBe('389 / 480 GB');
    expect(formatRate(1.2 * 1024 ** 2)).toBe('1,2 MB/s');
  });

  it('formats uptime as days and hours', () => {
    expect(formatUptime(12 * 86400 + 4 * 3600 + 120)).toBe('12 T 4 h');
    expect(formatUptime(41 * 86400)).toBe('41 T');
    expect(formatUptime(4 * 3600 + 12 * 60)).toBe('4 h 12 Min');
    expect(formatUptime(90)).toBe('1 Min');
    expect(formatUptime(null)).toBe('—');
    expect(formatUptimeShort(41 * 86400 + 5 * 3600)).toBe('41 T');
    expect(formatUptimeShort(3 * 3600)).toBe('3 h');
  });

  it('shows time for today and date for other days', () => {
    const now = new Date(2026, 10, 25, 23, 30);
    expect(formatWhen(new Date(2026, 10, 25, 23, 4), now)).toBe('23:04');
    expect(formatWhen(new Date(2026, 10, 24, 8, 5), now)).toBe('24.11. 08:05');
  });

  it('pluralises', () => {
    expect(plural(1, 'Problem', 'Probleme')).toBe('1 Problem');
    expect(plural(2, 'Problem', 'Probleme')).toBe('2 Probleme');
  });
});
