import { describe, expect, it } from 'vitest';
import * as ui from './index.js';

// window.HZ in design/reference/bundle.js (and index.d.ts).
const BUNDLE = [
  'Icon',
  'Button',
  'StatusDot',
  'Badge',
  'Tile',
  'Metric',
  'UsageBar',
  'BlockBar',
  'Sparkline',
  'ServerList',
  'ServiceRow',
  'WebCheckRow',
  'RepoRow',
  'CommitRow',
  'GameServer',
  'GameTemplates',
  'ShareLink',
  'Toggle',
  'Alert',
  'Terminal',
  'NavRail',
  'ServerSwitch',
];

describe('@hz/ui exports', () => {
  it.each(BUNDLE)('exports %s', (name) => {
    expect(typeof (ui as Record<string, unknown>)[name]).toBe('function');
  });
});
