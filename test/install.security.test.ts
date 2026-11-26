import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/install.sh against stubbed docker, tailscale and curl: file modes, the
 * secret key (generated once, never printed, never in argv), tailscale serve
 * without funnel, and the uninstall/purge rules.
 */
const SCRIPT = resolve(import.meta.dirname, '../deploy/install.sh');

const STUB_DOCKER = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >>"$STUB_LOG"
case "$1" in
  info) exit 0 ;;
  --version) echo "Docker version 29.0.0, build stub"; exit 0 ;;
  volume) [[ "\${STUB_VOLUME:-0}" == 1 ]] && exit 0 || exit 1 ;;
  inspect) echo "2026-11-26T10:00:00Z"; exit 0 ;;
  compose)
    shift
    case "$1" in
      version) echo "Docker Compose version v2.40.0"; exit 0 ;;
      logs)
        if [[ "\${STUB_ADMIN:-0}" != 1 ]]; then
          echo '{"level":30,"msg":"Ersteinrichtung: https://heimserver.tail1234.ts.net/setup#token=SETUPTOKENabcdefghijklmnop"}'
        fi
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

const STUB_TAILSCALE = `#!/usr/bin/env bash
printf 'tailscale %s\\n' "$*" >>"$STUB_LOG"
if [[ "$1 $2" == "status --json" ]]; then
  echo '{"BackendState": "Running", "Self": {"DNSName": "heimserver.tail1234.ts.net."}, "Peer": {"x": {"DNSName": "other.tail1234.ts.net."}}}'
  exit 0
fi
if [[ "$1 $2 $3" == "serve status --json" ]]; then
  if [[ "\${STUB_FUNNEL:-0}" == 1 ]]; then
    echo '{"AllowFunnel": {"heimserver.tail1234.ts.net:443": true}}'
  else
    echo '{}'
  fi
  exit 0
fi
exit 0
`;

const STUB_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >>"$STUB_LOG"
for a in "$@"; do [[ "$a" == "-w" ]] && { printf 200; exit 0; }; done
echo '{"ok":true}'
`;

interface Env {
  dir: string;
  conf: string;
  share: string;
  log: string;
  bin: string;
}

let env: Env;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-install-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [
    ['docker', STUB_DOCKER],
    ['tailscale', STUB_TAILSCALE],
    ['curl', STUB_CURL],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  env = {
    dir,
    bin,
    conf: join(dir, 'etc', 'homelab-zentrale'),
    share: join(dir, 'etc', 'homelab-share'),
    log: join(dir, 'calls.log'),
  };
  mkdirSync(join(dir, 'etc'));
  writeFileSync(env.log, '');
});

function run(args: string[], extra: Record<string, string> = {}, opts: { bash?: string[] } = {}) {
  const res = spawnSync('bash', [...(opts.bash ?? []), SCRIPT, ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${env.bin}:/usr/bin:/bin`,
      HOME: env.dir,
      LANG: 'C.UTF-8',
      HZ_INSTALL_ALLOW_NONROOT: '1',
      HZ_CONF_DIR: env.conf,
      HZ_SHARE_CONF_DIR: env.share,
      HZ_CADDY_FILE: join(env.dir, 'Caddyfile'),
      HZ_HEALTH_TIMEOUT: '4',
      STUB_LOG: env.log,
      ...extra,
    },
  });
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: readFileSync(env.log, 'utf8'),
  };
}

const coreEnv = () => readFileSync(join(env.conf, 'core.env'), 'utf8');
const keyOf = (text: string) => /^HZ_SECRET_KEY=(.*)$/m.exec(text)?.[1] ?? '';
const mode = (p: string) => statSync(p).mode & 0o777;

describe('deploy/install.sh (core)', () => {
  it('fresh install: 0600 env with a random 32-byte key, ts.net base URL, never prints the key', () => {
    const r = run(['--yes', '--timezone', 'Europe/Vienna']);
    expect(r.code, r.out).toBe(0);
    expect(mode(env.conf)).toBe(0o700);
    expect(mode(join(env.conf, 'core.env'))).toBe(0o600);
    const text = coreEnv();
    const key = keyOf(text);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(text).toContain('HZ_BASE_URL=https://heimserver.tail1234.ts.net\n');
    expect(text).toContain('HZ_TIMEZONE=Europe/Vienna\n');
    expect(text).toContain('HZ_INITIAL_MODULES=github=0,homeassistant=0,games=1\n');
    // Never in the output, never as an argument of any command.
    expect(r.out).not.toContain(key);
    expect(r.calls).not.toContain(key);
    expect(r.out).toContain('HZ_SECRET_KEY sichern');
    // First login link from the core log.
    expect(r.out).toContain('https://heimserver.tail1234.ts.net/setup#token=SETUPTOKEN');
    // Compose: install copy uses core.env (required), the interpolation .env has no secret.
    const compose = readFileSync(join(env.conf, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('path: ./core.env');
    expect(compose).toContain('required: true');
    expect(compose).toContain('127.0.0.1');
    const interp = readFileSync(join(env.conf, '.env'), 'utf8');
    expect(interp).toContain('HZ_CORE_IMAGE=ghcr.io/puffybooy/homelab-core:latest');
    expect(interp).not.toContain(key);
    expect(r.calls).toContain('docker compose pull core');
    expect(r.calls).toContain('docker compose up -d --no-build --force-recreate core');
  });

  it('tailscale serve on 443 to loopback only, never funnel', () => {
    const r = run(['--yes', '--timezone', 'UTC']);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain('tailscale serve --bg --https=443 http://127.0.0.1:8080');
    expect(r.calls).not.toMatch(/tailscale funnel(?! --https=443 off)/);
    expect(r.calls).not.toContain('funnel --https=443 on');
  });

  it('turns an existing funnel off', () => {
    const r = run(['--yes', '--timezone', 'UTC'], { STUB_FUNNEL: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain('tailscale funnel --https=443 off');
  });

  it('is idempotent: a second run keeps the key, --modules updates the wizard choice', () => {
    expect(run(['--yes', '--timezone', 'UTC']).code).toBe(0);
    const key = keyOf(coreEnv());
    const r = run(['--yes', '--modules', 'github=1,homeassistant=1,games=0']);
    expect(r.code, r.out).toBe(0);
    expect(keyOf(coreEnv())).toBe(key);
    expect(coreEnv().match(/^HZ_SECRET_KEY=/gm)).toHaveLength(1);
    expect(coreEnv()).toContain('HZ_INITIAL_MODULES=github=1,homeassistant=1,games=0\n');
    expect(r.out).toContain('bleibt unverändert');
    expect(r.out).not.toContain('HZ_SECRET_KEY sichern');
  });

  it('bash -x does not leak the key (xtrace is switched off)', () => {
    const r = run(['--yes', '--timezone', 'UTC'], {}, { bash: ['-x'] });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('xtrace');
    expect(r.out).not.toContain(keyOf(coreEnv()));
  });

  it('refuses to create a new key when data already exists', () => {
    const r = run(['--yes', '--timezone', 'UTC'], { STUB_VOLUME: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('keinen HZ_SECRET_KEY');
    expect(existsSync(join(env.conf, 'core.env')) ? keyOf(coreEnv()) : '').toBe('');
  });

  it('takes over the key of a manual install in the checkout', () => {
    // Fake checkout: copy of the script next to the compose file and a .env.
    const repo = join(env.dir, 'repo');
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    for (const f of ['install.sh', 'docker-compose.core.yml']) {
      writeFileSync(
        join(repo, 'deploy', f),
        readFileSync(resolve(import.meta.dirname, '../deploy', f)),
      );
    }
    const old = Buffer.alloc(32, 9).toString('base64');
    writeFileSync(join(repo, '.env'), `HZ_SECRET_KEY=${old}\n`);
    const res = spawnSync(
      'bash',
      [join(repo, 'deploy', 'install.sh'), '--yes', '--timezone', 'UTC'],
      {
        encoding: 'utf8',
        input: '',
        env: {
          PATH: `${env.bin}:/usr/bin:/bin`,
          HOME: env.dir,
          HZ_INSTALL_ALLOW_NONROOT: '1',
          HZ_CONF_DIR: env.conf,
          HZ_HEALTH_TIMEOUT: '4',
          STUB_LOG: env.log,
          STUB_VOLUME: '1',
        },
      },
    );
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(keyOf(coreEnv())).toBe(old);
    expect(res.stdout + res.stderr).not.toContain(old);
  });

  it('rejects secrets as arguments, non-ts.net base URLs and malformed modules', () => {
    for (const args of [
      ['--token', 'x'],
      ['--secret-key=abc'],
      ['--base-url', 'https://zentrale.example.com'],
      ['--base-url', 'http://heimserver.tail1234.ts.net'],
      ['--modules', 'github=1;id'],
      ['--modules', 'nas=1'],
      ['--timezone', '../../etc/passwd'],
      ['--image', 'evil image'],
    ]) {
      const r = run(['--yes', ...args]);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(existsSync(join(env.conf, 'core.env')), args.join(' ')).toBe(false);
    }
  });

  it('update keeps the configuration; status shows no link once an admin exists', () => {
    expect(run(['--yes', '--timezone', 'UTC']).code).toBe(0);
    const before = coreEnv();
    const u = run(['update', '--yes'], { STUB_ADMIN: '1' });
    expect(u.code, u.out).toBe(0);
    expect(coreEnv()).toBe(before);
    expect(u.out).not.toContain('setup#token');
    expect(u.out).toContain('Anmelden: https://heimserver.tail1234.ts.net');
  });

  it('uninstall keeps data and key; purge needs --yes without a terminal', () => {
    expect(run(['--yes', '--timezone', 'UTC']).code).toBe(0);
    const u = run(['uninstall', '--yes']);
    expect(u.code, u.out).toBe(0);
    expect(u.calls).toContain('tailscale serve --https=443 off');
    expect(u.calls).toContain('docker compose down --remove-orphans');
    expect(u.calls).not.toContain('down -v');
    expect(existsSync(join(env.conf, 'core.env'))).toBe(true);

    expect(run(['--yes', '--timezone', 'UTC']).code).toBe(0);
    const p = run(['uninstall', '--purge']);
    expect(p.code).not.toBe(0);
    expect(existsSync(join(env.conf, 'core.env'))).toBe(true);
    const p2 = run(['uninstall', '--purge', '--yes']);
    expect(p2.code, p2.out).toBe(0);
    expect(p2.calls).toContain('docker compose down -v --remove-orphans');
    expect(existsSync(env.conf)).toBe(false);
  });
});

describe('deploy/install.sh share', () => {
  const token = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;

  it('writes the gateway token 0600, never prints it or passes it as an argument', () => {
    const r = run(['share', '--yes', '--core-url', 'https://heimserver.tail1234.ts.net'], {
      HZ_SHARE_GATEWAY_TOKEN: token,
    });
    expect(r.code, r.out).toBe(0);
    expect(mode(env.share)).toBe(0o700);
    const file = join(env.share, 'share.env');
    expect(mode(file)).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`HZ_SHARE_GATEWAY_TOKEN=${token}\n`);
    expect(text).toContain('HZ_SHARE_CORE_URL=https://heimserver.tail1234.ts.net\n');
    expect(r.out).not.toContain(token);
    expect(r.calls).not.toContain(token);
    expect(readFileSync(join(env.share, 'docker-compose.yml'), 'utf8')).toContain(file);
    expect(r.calls).toContain('docker compose up -d --no-build --force-recreate share');
  });

  it('rejects a malformed token, a public core URL and the token as argument', () => {
    const bad = run(['share', '--yes', '--core-url', 'https://heimserver.tail1234.ts.net'], {
      HZ_SHARE_GATEWAY_TOKEN: 'short',
    });
    expect(bad.code).not.toBe(0);
    expect(bad.out).not.toContain('short\n');
    const pub = run(['share', '--yes', '--core-url', 'https://zentrale.example.com'], {
      HZ_SHARE_GATEWAY_TOKEN: token,
    });
    expect(pub.code).not.toBe(0);
    expect(run(['share', '--yes', '--token', token]).code).not.toBe(0);
    expect(existsSync(join(env.share, 'share.env'))).toBe(false);
  });

  it('Caddy: only the validated domain is written', () => {
    writeFileSync(join(env.bin, 'caddy'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(env.bin, 'caddy'), 0o755);
    writeFileSync(join(env.bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(env.bin, 'systemctl'), 0o755);
    const args = ['share', '--yes', '--core-url', 'https://heimserver.tail1234.ts.net'];
    const r = run([...args, '--domain', 'spiel.example.org'], { HZ_SHARE_GATEWAY_TOKEN: token });
    expect(r.code, r.out).toBe(0);
    const caddy = readFileSync(join(env.dir, 'Caddyfile'), 'utf8');
    expect(caddy).toContain('spiel.example.org {');
    expect(caddy).not.toContain('duckdns');
    for (const d of ['spiel.example.org{ }', 'x.ts.net', 'a/b.example.org']) {
      expect(run([...args, '--domain', d], { HZ_SHARE_GATEWAY_TOKEN: token }).code, d).not.toBe(0);
    }
  });
});

describe('shellcheck', () => {
  const have = spawnSync('shellcheck', ['--version']).status === 0;
  it.skipIf(!have)('deploy/*.sh are clean', () => {
    const dir = resolve(import.meta.dirname, '../deploy');
    const r = spawnSync('shellcheck', [join(dir, 'install.sh'), join(dir, 'install-agent.sh')], {
      encoding: 'utf8',
    });
    expect(r.status, r.stdout).toBe(0);
  });
});
