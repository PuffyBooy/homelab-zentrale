import { describe, expect, it } from 'vitest';
import { alertQuery, alertsAllKey, alertsFilterKey, filterFromParams } from './alerts.js';

describe('alert filter', () => {
  it('reads known values from the URL and drops the rest', () => {
    const f = filterFromParams(
      new URLSearchParams('state=resolved&level=crit&source=check'),
      'srv-home0001',
    );
    expect(f).toEqual({
      state: 'resolved',
      level: 'crit',
      source: 'check',
      serverId: 'srv-home0001',
    });
    expect(filterFromParams(new URLSearchParams('state=x&level=boom&source=../'))).toEqual({
      state: 'active',
      level: undefined,
      source: undefined,
      serverId: undefined,
    });
    expect(filterFromParams(new URLSearchParams(), 'a&b=c').serverId).toBeUndefined();
  });

  it('builds the query for GET /api/alerts', () => {
    expect(alertQuery({ state: 'active' })).toBe('state=active&limit=200');
    expect(alertQuery({ state: 'all', level: 'warn', serverId: 'srv-1', source: 'server' })).toBe(
      'state=all&limit=200&level=warn&serverId=srv-1&source=server',
    );
  });

  it('keys the filtered list under alertsAllKey (refetched on live updates)', () => {
    const key = alertsFilterKey({ state: 'open', level: 'crit' });
    expect(key.slice(0, alertsAllKey.length)).toEqual([...alertsAllKey]);
  });
});
