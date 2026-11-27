import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/install.sh repair-apt against a stubbed apt-get: a broken Ubuntu country
 * mirror is replaced by archive.ubuntu.com (only after consent, with a backup),
 * any other apt failure is left alone.
 */
const SCRIPT = resolve(import.meta.dirname, '../deploy/install.sh');

// Fails like apt does while any sources file still names the broken mirror.
const STUB_APT = `#!/usr/bin/env bash
printf 'apt-get %s\\n' "$*" >>"$STUB_LOG"
[[ "$1" == update ]] || exit 0
if [[ -n "\${STUB_APT_FAIL_OTHER:-}" ]]; then
  echo "Err:4 https://ppa.example.org/ubuntu jammy Release"
  echo "E: The repository 'https://ppa.example.org/ubuntu jammy Release' does not have a Release file."
  exit 100
fi
if grep -rqs 'at.archive.ubuntu.com' "$HZ_APT_DIR"; then
  echo "Ign:1 http://at.archive.ubuntu.com/ubuntu jammy InRelease"
  echo "Err:5 http://at.archive.ubuntu.com/ubuntu jammy Release"
  echo "  404  Not Found [IP: 192.0.2.1 80]"
  echo "E: Das Depot »http://at.archive.ubuntu.com/ubuntu jammy Release« enthält keine Release-Datei mehr."
  exit 100
fi
echo "Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease"
`;

const LIST = `deb http://at.archive.ubuntu.com/ubuntu/ jammy main restricted
deb http://at.archive.ubuntu.com/ubuntu/ jammy-updates main restricted
deb http://at.archive.ubuntu.com/ubuntu/ jammy-backports main restricted
deb http://security.ubuntu.com/ubuntu jammy-security main restricted
`;
const SOURCES = `Types: deb
URIs: https://at.archive.ubuntu.com/ubuntu/
Suites: jammy jammy-updates
Components: main
`;
const DOCKER = 'deb https://download.docker.com/linux/ubuntu jammy stable\n';

let dir: string;
let apt: string;
let backups: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hz-apt-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'apt-get'), STUB_APT);
  chmodSync(join(bin, 'apt-get'), 0o755);
  apt = join(dir, 'apt');
  mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
  writeFileSync(join(apt, 'sources.list'), LIST);
  writeFileSync(join(apt, 'sources.list.d', 'ubuntu.sources'), SOURCES);
  writeFileSync(join(apt, 'sources.list.d', 'docker.list'), DOCKER);
  backups = join(dir, 'backups');
  log = join(dir, 'calls.log');
  writeFileSync(log, '');
});

function run(args: string[], extra: Record<string, string> = {}) {
  const res = spawnSync('bash', [SCRIPT, 'repair-apt', ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      HOME: dir,
      LANG: 'C.UTF-8',
      HZ_INSTALL_ALLOW_NONROOT: '1',
      HZ_APT_DIR: apt,
      HZ_APT_BACKUP_DIR: backups,
      STUB_LOG: log,
      ...extra,
    },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, calls: readFileSync(log, 'utf8') };
}

const read = (...p: string[]) => readFileSync(join(apt, ...p), 'utf8');
const updates = (calls: string) =>
  calls.split('\n').filter((l) => l === 'apt-get update -q').length;

describe('deploy/install.sh repair-apt', () => {
  it('switches a broken country mirror to archive.ubuntu.com, with a backup, then retries', () => {
    const r = run(['--yes']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('at.archive.ubuntu.com liefert die Paketlisten nicht');
    expect(updates(r.calls)).toBe(2);
    expect(read('sources.list')).toBe(
      LIST.replaceAll('at.archive.ubuntu.com', 'archive.ubuntu.com'),
    );
    expect(read('sources.list')).toContain('http://security.ubuntu.com/ubuntu jammy-security');
    expect(read('sources.list.d', 'ubuntu.sources')).toContain(
      'URIs: https://archive.ubuntu.com/ubuntu/',
    );
    expect(read('sources.list.d', 'docker.list')).toBe(DOCKER);
    // Backup: one folder with the originals of the changed files only.
    const b = readdirSync(backups)[0] ?? '';
    expect(b).toMatch(/^apt-sources-\d{8}-\d{6}$/);
    expect(readFileSync(join(backups, b, 'sources.list'), 'utf8')).toBe(LIST);
    expect(readFileSync(join(backups, b, 'sources.list.d', 'ubuntu.sources'), 'utf8')).toBe(
      SOURCES,
    );
    expect(existsSync(join(backups, b, 'sources.list.d', 'docker.list'))).toBe(false);
  });

  it('without a terminal and without --yes nothing is changed', () => {
    const r = run([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("sed -i 's|://at.archive.ubuntu.com|://archive.ubuntu.com|g'");
    expect(updates(r.calls)).toBe(1);
    expect(read('sources.list')).toBe(LIST);
    expect(existsSync(backups)).toBe(false);
  });

  it('leaves other apt failures alone', () => {
    const r = run(['--yes'], { STUB_APT_FAIL_OTHER: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('apt-get update ist fehlgeschlagen');
    expect(read('sources.list')).toBe(LIST);
    expect(existsSync(backups)).toBe(false);
  });

  it('does nothing when apt update works', () => {
    writeFileSync(join(apt, 'sources.list'), LIST.replaceAll('at.archive', 'archive'));
    writeFileSync(join(apt, 'sources.list.d', 'ubuntu.sources'), DOCKER);
    const r = run(['--yes']);
    expect(r.code, r.out).toBe(0);
    expect(updates(r.calls)).toBe(1);
    expect(existsSync(backups)).toBe(false);
  });
});
