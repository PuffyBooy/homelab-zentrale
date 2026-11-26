import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_SCAN_MAX_VULNS,
  TRIVY_IMAGE_DEFAULT,
  imageScanDataSchema,
  parseRpc,
} from '@hz/shared';
import { resolveTrivyImage } from '../src/config.js';
import {
  SCAN_MAX_BUFFER,
  SCAN_TIMEOUT_MS,
  imageScan,
  parseTrivyReport,
  pinnedRefFor,
  trivyArgs,
} from '../src/actions/image-scan.js';
import type { RunResult } from '../src/exec.js';
import { makeCtx } from './game-helpers.js';

const DIGEST = `sha256:${'1'.repeat(64)}`;
const DIGEST2 = `sha256:${'2'.repeat(64)}`;

function fakeDocker(image: { config: string; repoDigests: string[] | undefined }): Docker {
  return {
    getContainer: (ref: string) => ({
      inspect: async () => {
        if (ref === 'missing') throw Object.assign(new Error('no such'), { statusCode: 404 });
        return { Image: 'sha256:abc', Config: { Image: image.config } };
      },
    }),
    getImage: () => ({ inspect: async () => ({ RepoDigests: image.repoDigests }) }),
  } as unknown as Docker;
}

function report(vulns: unknown[]): string {
  return JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'x', Vulnerabilities: vulns }] });
}

function v(id: string, severity: string, pkg = 'openssl', fixed = '3.0.2') {
  return {
    VulnerabilityID: id,
    PkgName: pkg,
    InstalledVersion: '3.0.1',
    FixedVersion: fixed,
    Severity: severity,
    Title: `title ${id}`,
  };
}

describe('trivy arguments', () => {
  it('are exactly the fixed list: no docker socket, no host path', () => {
    const ref = `nginx:1.27@${DIGEST}`;
    const args = trivyArgs(TRIVY_IMAGE_DEFAULT, ref);
    expect(args).toEqual([
      'run',
      '--rm',
      '--pull',
      'missing',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '1g',
      '--pids-limit',
      '256',
      '--tmpfs',
      '/tmp:rw,size=512m',
      '-v',
      'hz-trivy-cache:/root/.cache',
      TRIVY_IMAGE_DEFAULT,
      'image',
      '--quiet',
      '--format',
      'json',
      '--scanners',
      'vuln',
      '--severity',
      'CRITICAL,HIGH',
      '--image-src',
      'remote',
      '--timeout',
      '10m',
      '--',
      ref,
    ]);
    const joined = args.join(' ');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('--privileged');
    // the only volume is the named cache volume, never a host path
    const volumes = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []));
    expect(volumes).toEqual(['hz-trivy-cache:/root/.cache']);
    expect(args.some((a) => a.startsWith('--mount') || a.startsWith('--volume'))).toBe(false);
  });

  it('refuses unpinned scanner images and refs', () => {
    expect(() => trivyArgs('aquasec/trivy:latest', `nginx@${DIGEST}`)).toThrow();
    expect(() => trivyArgs(TRIVY_IMAGE_DEFAULT, 'nginx:latest')).toThrow();
    expect(() => trivyArgs(TRIVY_IMAGE_DEFAULT, `-h@${DIGEST}`)).toThrow();
    expect(() => trivyArgs(TRIVY_IMAGE_DEFAULT, `--config=/x@${DIGEST}`)).toThrow();
  });

  it('HZ_AGENT_TRIVY_IMAGE must be pinned, else the default', () => {
    expect(resolveTrivyImage(undefined)).toEqual({ image: TRIVY_IMAGE_DEFAULT, rejected: false });
    expect(resolveTrivyImage('aquasec/trivy:latest')).toEqual({
      image: TRIVY_IMAGE_DEFAULT,
      rejected: true,
    });
    const own = `registry.example.com/trivy:0.1@${DIGEST}`;
    expect(resolveTrivyImage(own)).toEqual({ image: own, rejected: false });
  });
});

describe('image refs', () => {
  it('picks the RepoDigest of the configured repo and keeps the tag', () => {
    expect(pinnedRefFor('nginx:1.27', [`other/img@${DIGEST2}`, `nginx@${DIGEST}`])).toEqual({
      ref: `nginx:1.27@${DIGEST}`,
      digest: DIGEST,
    });
    expect(pinnedRefFor('docker.io/library/nginx:1.27', [`nginx@${DIGEST}`])?.ref).toBe(
      `nginx:1.27@${DIGEST}`,
    );
    expect(pinnedRefFor('ghcr.io/a/b', [`ghcr.io/a/b@${DIGEST}`])?.ref).toBe(
      `ghcr.io/a/b@${DIGEST}`,
    );
  });

  it('falls back to the first digest without a tag', () => {
    expect(pinnedRefFor('sha256:abc', [`x/y@${DIGEST}`])?.ref).toBe(`x/y@${DIGEST}`);
  });

  it('no or odd digests -> null', () => {
    expect(pinnedRefFor('myapp:dev', [])).toBeNull();
    expect(pinnedRefFor('myapp:dev', ['myapp@sha256:short'])).toBeNull();
    // registry with port is outside the pinned-ref schema: not scannable
    expect(pinnedRefFor('localhost:5000/app', [`localhost:5000/app@${DIGEST}`])).toBeNull();
  });
});

describe('trivy report parsing', () => {
  it('dedupes, counts, sorts critical first, drops other severities', () => {
    const r = parseTrivyReport(
      report([
        v('CVE-1', 'HIGH'),
        v('CVE-2', 'CRITICAL'),
        v('CVE-1', 'HIGH'),
        v('CVE-1', 'HIGH', 'libssl'),
        v('CVE-3', 'MEDIUM'),
        v('CVE-4', 'CRITICAL', 'zlib', ''),
      ]),
    );
    expect(r?.counts).toEqual({ critical: 2, high: 2 });
    expect(r?.vulns.map((x) => `${x.severity}:${x.id}:${x.pkg}`)).toEqual([
      'CRITICAL:CVE-2:openssl',
      'CRITICAL:CVE-4:zlib',
      'HIGH:CVE-1:openssl',
      'HIGH:CVE-1:libssl',
    ]);
    expect(r?.vulns[1]?.fixed).toBeNull();
  });

  it('caps the list and cuts long strings', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...v(`CVE-${i}`, 'HIGH'),
      Title: 'x'.repeat(5000),
    }));
    const r = parseTrivyReport(report(many));
    expect(r?.counts.high).toBe(300);
    expect(r?.vulns).toHaveLength(IMAGE_SCAN_MAX_VULNS);
    expect(r?.vulns[0]?.title.length).toBe(300);
  });

  it('a report without results is clean', () => {
    expect(parseTrivyReport('{"SchemaVersion":2}')).toEqual({
      counts: { critical: 0, high: 0 },
      vulns: [],
    });
  });

  it('malformed JSON -> null', () => {
    expect(parseTrivyReport('not json')).toBeNull();
    expect(parseTrivyReport('[]')).toBeNull();
    expect(parseTrivyReport('{"Results":"x"}')).toBeNull();
    expect(parseTrivyReport('{"Results":[{"Vulnerabilities":[null,1,"x"]}]}')).toEqual({
      counts: { critical: 0, high: 0 },
      vulns: [],
    });
  });
});

describe('image.scan action', () => {
  it('runs trivy through the docker CLI and returns the counts', async () => {
    const { ctx, rec } = makeCtx('/nonexistent', {}, {
      code: 0,
      stdout: report([v('CVE-9', 'CRITICAL')]),
      stderr: '',
    } satisfies RunResult);
    ctx.host.docker = fakeDocker({ config: 'nginx:1.27', repoDigests: [`nginx@${DIGEST}`] });
    const data = await imageScan({ id: 'web' }, ctx);
    expect(imageScanDataSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      image: 'nginx:1.27',
      digest: DIGEST,
      scannable: true,
      reason: null,
      counts: { critical: 1, high: 0 },
    });
    expect(rec.runs).toHaveLength(1);
    const run = rec.runs[0];
    expect(run?.file).toBe('docker');
    expect(run?.args).toEqual(trivyArgs(TRIVY_IMAGE_DEFAULT, `nginx:1.27@${DIGEST}`));
    expect(run?.opts).toEqual({
      timeoutMs: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: '/tmp/.docker' },
    });
  });

  it('locally built image -> local_image, no scan', async () => {
    const { ctx, rec } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker({ config: 'myapp:dev', repoDigests: [] });
    const data = await imageScan({ id: 'web' }, ctx);
    expect(data).toMatchObject({ scannable: false, reason: 'local_image', digest: null });
    expect(rec.runs).toHaveLength(0);
    ctx.host.docker = fakeDocker({ config: 'myapp:dev', repoDigests: undefined });
    expect((await imageScan({ id: 'web' }, ctx)).reason).toBe('local_image');
  });

  it('malformed trivy output or non-zero exit -> scan_failed', async () => {
    for (const r of [
      { code: 0, stdout: '{"Results": [', stderr: '' },
      { code: 1, stdout: report([]), stderr: 'FATAL registry unreachable' },
      { code: null, stdout: '', stderr: '', error: 'timeout' as const },
    ]) {
      const { ctx } = makeCtx('/nonexistent', {}, r);
      ctx.host.docker = fakeDocker({ config: 'nginx', repoDigests: [`nginx@${DIGEST}`] });
      const data = await imageScan({ id: 'web' }, ctx);
      expect(data).toMatchObject({
        scannable: false,
        reason: 'scan_failed',
        counts: { critical: 0, high: 0 },
        vulns: [],
      });
    }
  });

  it('uses the configured scanner image', async () => {
    const own = `registry.example.com/trivy:0.1@${DIGEST2}`;
    const { ctx, rec } = makeCtx(
      '/nonexistent',
      { trivyImage: own },
      {
        code: 0,
        stdout: report([]),
        stderr: '',
      },
    );
    ctx.host.docker = fakeDocker({ config: 'nginx', repoDigests: [`nginx@${DIGEST}`] });
    await imageScan({ id: 'web' }, ctx);
    expect(rec.runs[0]?.args).toContain(own);
  });

  it('one scan at a time (busy)', async () => {
    let release: (r: RunResult) => void = () => undefined;
    const { ctx } = makeCtx('/nonexistent', {
      run: () =>
        new Promise<RunResult>((resolve) => {
          release = resolve;
        }),
    });
    ctx.host.docker = fakeDocker({ config: 'nginx', repoDigests: [`nginx@${DIGEST}`] });
    const first = imageScan({ id: 'web' }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    await expect(imageScan({ id: 'web' }, ctx)).rejects.toMatchObject({ code: 'busy' });
    release({ code: 0, stdout: report([]), stderr: '' });
    expect((await first).scannable).toBe(true);
    // released afterwards
    const { ctx: ctx2 } = makeCtx('/nonexistent', {}, { code: 0, stdout: report([]), stderr: '' });
    ctx2.host.docker = ctx.host.docker;
    expect((await imageScan({ id: 'web' }, ctx2)).scannable).toBe(true);
  });

  it('unknown container -> not_found', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker({ config: 'nginx', repoDigests: [] });
    await expect(imageScan({ id: 'missing' }, ctx)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the protocol only accepts a container ref (no image names, no options)', () => {
    const env = (p: unknown) => ({
      type: 'rpc' as const,
      id: 'r1',
      action: 'image.scan',
      params: p,
    });
    expect(parseRpc(env({ id: 'web' })).ok).toBe(true);
    expect(parseRpc(env({ id: '-h' })).ok).toBe(false);
    expect(parseRpc(env({ id: 'web', image: 'nginx' })).ok).toBe(false);
    expect(parseRpc(env({ id: 'a b' })).ok).toBe(false);
  });
});
