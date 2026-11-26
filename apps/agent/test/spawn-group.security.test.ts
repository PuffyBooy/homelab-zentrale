import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnFile } from '../src/exec.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hz-spawn-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noop = { onStdout: () => undefined, onStderr: () => undefined };

describe('spawnFile process group', () => {
  it('a timeout also ends background grandchildren that hold the pipes', async () => {
    const script = path.join(dir, 'deploy.sh');
    await writeFile(script, 'sleep 30 &\nsleep 30\n');
    const started = Date.now();
    const h = spawnFile('/bin/sh', [script], noop, { cwd: dir, timeoutMs: 300 });
    const r = await h.done;
    expect(r.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a normal exit is not held open by a background child', async () => {
    const script = path.join(dir, 'deploy.sh');
    await writeFile(script, 'sleep 30 &\necho done\n');
    const started = Date.now();
    let out = '';
    const h = spawnFile(
      '/bin/sh',
      [script],
      { onStdout: (c) => (out += c.toString()), onStderr: () => undefined },
      { cwd: dir, timeoutMs: 20_000 },
    );
    const r = await h.done;
    expect(r.code).toBe(0);
    expect(out).toContain('done');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('cancel kills the whole group', async () => {
    const script = path.join(dir, 'deploy.sh');
    await writeFile(script, 'sleep 30 &\nsleep 30\n');
    const h = spawnFile('/bin/sh', [script], noop, { cwd: dir, timeoutMs: 20_000 });
    setTimeout(() => h.kill(), 200);
    const r = await h.done;
    expect(r.error).toBe('killed');
  });
});
