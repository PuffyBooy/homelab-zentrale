import { defaultThresholds } from '@hz/shared';
import { describe, expect, it } from 'vitest';
import { changedThresholds, exportFileName, parseThresholds, thresholdDraft } from './settings.js';

describe('settings', () => {
  it('round-trips thresholds through the form with a decimal comma', () => {
    const draft = thresholdDraft({ ...defaultThresholds, cpuWarn: 82.5 });
    expect(draft.cpuWarn).toBe('82,5');
    const parsed = parseThresholds(draft);
    expect(parsed.ok && parsed.value.cpuWarn).toBe(82.5);
  });

  it('rejects out-of-range, non-integer minutes and warn above crit', () => {
    const draft = {
      ...thresholdDraft(defaultThresholds),
      cpuWarn: '120',
      cpuWarnMinutes: '2,5',
      diskWarn: '96',
      tempWarn: '',
    };
    const parsed = parseThresholds(draft);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual({
      cpuWarn: 'Erlaubt: 1 bis 100 %.',
      cpuWarnMinutes: 'Ganze Zahl eingeben.',
      diskWarn: 'Warnung muss unter kritisch liegen.',
      tempWarn: 'Zahl eingeben.',
    });
  });

  it('sends only changed thresholds', () => {
    expect(
      changedThresholds(defaultThresholds, { ...defaultThresholds, diskWarn: 80, tempWarn: 70 }),
    ).toEqual({ diskWarn: 80, tempWarn: 70 });
  });

  it('takes the export file name from the header, else builds a safe one', () => {
    expect(exportFileName('attachment; filename="homelab-zentrale-20261126-2304.sqlite"')).toBe(
      'homelab-zentrale-20261126-2304.sqlite',
    );
    expect(
      exportFileName('attachment; filename="../../etc/passwd"', new Date(2026, 10, 26, 23, 4)),
    ).toBe('homelab-zentrale-20261126-2304.sqlite');
    expect(exportFileName(null, new Date(2026, 0, 2, 3, 4))).toBe(
      'homelab-zentrale-20260102-0304.sqlite',
    );
  });
});
