import { describe, expect, it } from 'vitest';
import { defaultThresholds, type Thresholds } from '@hz/shared';
import {
  evaluateStatus,
  sustainedAbove,
  type Sample,
  type StatusInput,
} from '../src/servers/status.js';
import { celsius, clockTime, clockTimeRelative, duration, percent } from '../src/format.js';

// 2026-11-25 23:04:00 in Vienna (UTC+1).
const NOW = Date.UTC(2026, 10, 25, 22, 4, 0);
const MIN = 60_000;

/** One sample every 10 s for `minutes`, ending at NOW. */
function series(minutes: number, v: Partial<Sample>): Sample[] {
  const out: Sample[] = [];
  for (let ts = NOW - minutes * MIN; ts <= NOW; ts += 10_000) {
    out.push({ ts, cpu: v.cpu ?? 10, ramPct: v.ramPct ?? 40 });
  }
  return out;
}

type Latest = NonNullable<StatusInput['latest']>;

function input(
  over: Omit<Partial<StatusInput>, 'latest'> & { latest?: Partial<Latest> } = {},
): StatusInput {
  const { latest, ...rest } = over;
  const base: Latest = { cpu: 10, ramPct: 40, disks: [{ mount: '/', pct: 50 }], temp: 45 };
  return {
    connected: true,
    disconnectedAt: null,
    lastSeen: NOW - 5_000,
    samples: series(15, {}),
    updates: { total: 0, security: 0 },
    rebootRequired: false,
    ...rest,
    latest: { ...base, ...latest },
  };
}

const T: Thresholds = defaultThresholds;

describe('evaluateStatus (SPEC 5.1)', () => {
  const cases: {
    name: string;
    in: StatusInput;
    t?: Partial<Thresholds>;
    status: string;
    codes: string[];
    text?: string;
  }[] = [
    { name: 'all fine', in: input(), status: 'ok', codes: [] },
    // Disk
    {
      name: 'disk 84.9 %',
      in: input({ latest: { disks: [{ mount: '/', pct: 84.9 }] } }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'disk 85 % warn',
      in: input({ latest: { disks: [{ mount: '/', pct: 85 }] } }),
      status: 'warn',
      codes: ['disk_warn'],
      text: 'Disk / bei 85 %',
    },
    {
      name: 'disk 94.99 % still warn',
      in: input({ latest: { disks: [{ mount: '/', pct: 94.99 }] } }),
      status: 'warn',
      codes: ['disk_warn'],
      text: 'Disk / bei 94 %',
    },
    {
      name: 'disk 96 % crit, fullest disk decides',
      in: input({
        latest: {
          disks: [
            { mount: '/', pct: 60 },
            { mount: '/srv', pct: 96.4 },
          ],
        },
      }),
      status: 'crit',
      codes: ['disk_crit'],
      text: 'Disk /srv bei 96 %',
    },
    // RAM
    { name: 'ram 89 %', in: input({ latest: { ramPct: 89 } }), status: 'ok', codes: [] },
    {
      name: 'ram 92 % warn',
      in: input({ latest: { ramPct: 92 } }),
      status: 'warn',
      codes: ['ram_warn'],
      text: 'RAM 92 %',
    },
    {
      name: 'ram 97 % only for 4 min: warn, not crit',
      in: input({
        samples: [
          ...series(15, { ramPct: 50 }).filter((s) => s.ts < NOW - 4 * MIN),
          ...series(4, { ramPct: 97 }),
        ],
        latest: { ramPct: 97 },
      }),
      status: 'warn',
      codes: ['ram_warn'],
    },
    {
      name: 'ram 97 % for 5 min: crit',
      in: input({ samples: series(6, { ramPct: 97 }), latest: { ramPct: 97 } }),
      status: 'crit',
      codes: ['ram_crit'],
      text: 'RAM 97 % seit 5 Min',
    },
    {
      name: 'ram 97 % for 5 min with one dip: warn',
      in: input({
        samples: series(6, { ramPct: 97 }).map((s, i) => (i === 10 ? { ...s, ramPct: 80 } : s)),
        latest: { ramPct: 97 },
      }),
      status: 'warn',
      codes: ['ram_warn'],
    },
    {
      name: 'ram high but samples only since 2 min (agent just connected): warn',
      in: input({ samples: series(2, { ramPct: 99 }), latest: { ramPct: 99 } }),
      status: 'warn',
      codes: ['ram_warn'],
    },
    // CPU
    {
      name: 'cpu 99 % for 9 min: ok',
      in: input({ samples: series(9, { cpu: 99 }), latest: { cpu: 99 } }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'cpu 91 % for 10 min: warn',
      in: input({ samples: series(11, { cpu: 91 }), latest: { cpu: 91 } }),
      status: 'warn',
      codes: ['cpu_warn'],
      text: 'CPU 91 % seit 10 Min',
    },
    {
      name: 'cpu exactly 85 % for 10 min: warn',
      in: input({ samples: series(10, { cpu: 85 }), latest: { cpu: 85 } }),
      status: 'warn',
      codes: ['cpu_warn'],
    },
    {
      name: 'cpu 84.9 % for 30 min: ok',
      in: input({ samples: series(30, { cpu: 84.9 }), latest: { cpu: 84.9 } }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'custom cpu window of 2 min',
      in: input({ samples: series(3, { cpu: 90 }), latest: { cpu: 90 } }),
      t: { cpuWarnMinutes: 2 },
      status: 'warn',
      codes: ['cpu_warn'],
      text: 'CPU 90 % seit 2 Min',
    },
    // Temperature
    { name: 'temp 74.9 °C', in: input({ latest: { temp: 74.9 } }), status: 'ok', codes: [] },
    {
      name: 'temp 75 °C warn',
      in: input({ latest: { temp: 78.4 } }),
      status: 'warn',
      codes: ['temp_warn'],
      text: 'Temperatur 78,4 °C',
    },
    { name: 'temp unknown', in: input({ latest: { temp: null } }), status: 'ok', codes: [] },
    // Updates, reboot
    {
      name: 'security updates',
      in: input({ updates: { total: 12, security: 3 } }),
      status: 'warn',
      codes: ['security_updates'],
      text: '3 Sicherheitsupdates offen',
    },
    {
      name: 'one security update',
      in: input({ updates: { total: 1, security: 1 } }),
      status: 'warn',
      codes: ['security_updates'],
      text: '1 Sicherheitsupdate offen',
    },
    {
      name: 'only normal updates',
      in: input({ updates: { total: 9, security: 0 } }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'reboot required',
      in: input({ rebootRequired: true }),
      status: 'warn',
      codes: ['reboot_required'],
      text: 'Neustart nötig',
    },
    // Offline
    {
      name: 'silent for 90 s: still up',
      in: input({ lastSeen: NOW - 90_000 }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'silent for 91 s: crit, values ignored',
      in: input({ lastSeen: NOW - 91_000, latest: { disks: [{ mount: '/', pct: 99 }] } }),
      status: 'crit',
      codes: ['offline'],
      text: 'Offline seit 23:02',
    },
    {
      name: 'socket closed 29 s ago: still up',
      in: input({ connected: false, disconnectedAt: NOW - 29_000, lastSeen: NOW - 29_000 }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'socket closed 30 s ago: crit',
      in: input({ connected: false, disconnectedAt: NOW - 30_000, lastSeen: NOW - 31_000 }),
      status: 'crit',
      codes: ['offline'],
    },
    {
      name: 'custom offlineAfterS 300',
      in: input({ lastSeen: NOW - 200_000 }),
      t: { offlineAfterS: 300 },
      status: 'ok',
      codes: [],
    },
    {
      name: 'core just booted: old lastSeen gets a grace period',
      in: input({ connected: false, lastSeen: NOW - 3_600_000, observedSince: NOW - 60_000 }),
      status: 'ok',
      codes: [],
    },
    {
      name: 'core booted 91 s ago, agent still away: crit',
      in: input({ connected: false, lastSeen: NOW - 3_600_000, observedSince: NOW - 91_000 }),
      status: 'crit',
      codes: ['offline'],
      text: 'Offline seit 22:04',
    },
    {
      name: 'never seen: off',
      in: input({ lastSeen: null }),
      status: 'off',
      codes: ['never_seen'],
    },
    // Combined: crit first
    {
      name: 'several reasons, crit first',
      in: input({
        latest: { disks: [{ mount: '/', pct: 97 }], temp: 80, ramPct: 91 },
        rebootRequired: true,
      }),
      status: 'crit',
      codes: ['disk_crit', 'ram_warn', 'temp_warn', 'reboot_required'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = evaluateStatus(c.in, { ...T, ...c.t }, NOW);
      expect(r.status).toBe(c.status);
      expect(r.reasons.map((x) => x.code)).toEqual(c.codes);
      if (c.text) expect(r.reasons[0]?.text).toBe(c.text);
    });
  }

  it('is pure: same input, same output', () => {
    const i = input({ samples: series(11, { cpu: 91 }), latest: { cpu: 91 } });
    expect(evaluateStatus(i, T, NOW)).toEqual(evaluateStatus(i, T, NOW));
  });
});

describe('sustainedAbove', () => {
  it('needs a sample near the window start', () => {
    const s = series(10, { cpu: 90 }).filter((x) => x.ts > NOW - 9 * MIN);
    expect(sustainedAbove(s, (x) => x.cpu, 85, 10 * MIN, NOW)).toBe(false);
    expect(sustainedAbove([], (x) => x.cpu, 85, 10 * MIN, NOW)).toBe(false);
  });
});

describe('format (Stimme und Text)', () => {
  it('uses Vienna time, comma decimals and a space before units', () => {
    expect(clockTime(NOW)).toBe('23:04');
    expect(clockTime(Date.UTC(2026, 6, 1, 21, 4))).toBe('23:04'); // summer time
    expect(clockTimeRelative(NOW - 86_400_000, NOW)).toBe('24.11. 23:04');
    expect(percent(95.99)).toBe('95 %');
    expect(celsius(21.44)).toBe('21,4 °C');
    expect(celsius(75)).toBe('75 °C');
    expect(duration(45_000)).toBe('45 s');
    expect(duration(6 * MIN)).toBe('6 Min');
    expect(duration(125 * MIN)).toBe('2 Std 5 Min');
    expect(duration(3 * 86_400_000)).toBe('3 T');
  });
});
