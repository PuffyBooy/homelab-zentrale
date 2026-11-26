import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blockDeviceNameSchema } from '@hz/shared';
import { SmartReader, collectStorage, parseMdstat, smartctlArgs } from '../src/collect/storage.js';
import { PROGRAMS, runFile } from '../src/exec.js';

describe('storage (security)', () => {
  it('smartctl gets fixed, read-only arguments and only valid disk names', () => {
    for (const bad of ['../sda', 'sda;rm', '-a', 'sda ', 'sda/../../etc', 'md0', 'loop0', '']) {
      expect(() => smartctlArgs('/r', bad), bad).toThrow();
    }
    const args = smartctlArgs('/r', 'sda');
    // Never a write/test/offline option, always the standby guard.
    for (const a of args)
      expect(a).not.toMatch(/^(-s|-t|-o|-S|--smart|--test|--offlineauto|--set)/);
    expect(args).toContain('--nocheck=standby,0');
  });

  it('smartctl is allowlisted, a shell still is not', () => {
    expect(PROGRAMS.has('smartctl')).toBe(true);
    expect(PROGRAMS.has('sh')).toBe(false);
    expect(() => runFile('sh', ['-c', 'id'])).toThrow(/not allowed/);
  });

  it('hostile names in mdstat are dropped', () => {
    const a = parseMdstat(
      'md0 : active raid1 sd$(id)[0] ../../x[1] sda1[2]\n   10 blocks [2/2] [UU]\nmdX : active raid1 sda1[0]\n',
    );
    expect(a).toHaveLength(1);
    expect(a[0]?.members.map((m) => m.device)).toEqual(['sda1']);
  });

  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('only sysfs entries with a disk name ever reach smartctl', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'hz-storage-sec-'));
    for (const n of ['sda', 'sdb -x', 'nvme0n1', 'dm-0', '..sda']) {
      await mkdir(path.join(tmp, 'sys/block', n), { recursive: true });
      await writeFile(path.join(tmp, 'sys/block', n, 'size'), '100\n');
    }
    const seen: string[] = [];
    const reader = new SmartReader(tmp, async (args) => {
      seen.push(args.at(-1) ?? '');
      return { code: 0, stdout: '{}', stderr: '' };
    });
    await collectStorage({ hostRoot: tmp, hostProc: tmp }, { smart: true, smartReader: reader });
    expect(seen.map((p) => path.basename(p)).sort()).toEqual(['nvme0n1', 'sda']);
    for (const p of seen)
      expect(blockDeviceNameSchema.safeParse(path.basename(p)).success).toBe(true);
  });
});
