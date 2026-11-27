import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_COMPOSE_MAX_BYTES, APP_RESERVED_KEYS, appTemplateMetaSchema } from '@hz/shared';
import { analyzeCompose, checkCompose, isAppDataPath } from '../src/appstore/compose-check.js';
import { templateKeys } from '../src/appstore/templates.js';
import { APP_FIXTURES } from './apps-helpers.js';

const keys = new Set<string>([...APP_RESERVED_KEYS, 'WEB_PORT', 'DNS_PORT', 'PASS', 'MODE']);
const portKeys = new Map<string, 'tcp' | 'udp'>([
  ['WEB_PORT', 'tcp'],
  ['DNS_PORT', 'udp'],
]);
const opts = { keys, portKeys };
const check = (text: string): string[] => checkCompose(text, opts);

/** A safe service with `extra` lines (indented 4) appended. */
const svc = (extra: string): string => `services:
  app:
    image: nginx:1.27
    ports:
      - "\${BIND}:\${WEB_PORT}:80"
${extra
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => `    ${l}`)
  .join('\n')}
`;

const expectRefused = (text: string, fragment?: string): void => {
  const problems = check(text);
  expect(problems.length).toBeGreaterThan(0);
  if (fragment !== undefined) expect(problems.join('\n')).toContain(fragment);
};

describe('compose safety check: accepted', () => {
  it('accepts the vaultwarden fixture and reports its published port', () => {
    const text = readFileSync(join(APP_FIXTURES, 'vaultwarden', 'compose.yml'), 'utf8');
    const meta = appTemplateMetaSchema.parse(
      JSON.parse(readFileSync(join(APP_FIXTURES, 'vaultwarden', 'template.json'), 'utf8')),
    );
    const a = analyzeCompose(text, templateKeys(meta));
    expect(a.problems).toEqual([]);
    expect(a.published).toEqual([{ key: 'WEB_PORT', protocol: 'tcp' }]);
    expect(a.services).toEqual(['vaultwarden']);
  });

  it('accepts long-form ports, named volumes, udp, env_file .env, $$ and bridge networks', () => {
    const text = `services:
  app:
    image: nginx:1.27
    container_name: \${APP_ID}-web
    env_file: .env
    environment:
      - PRICE=$$5
      - PASS=\${PASS}
    labels:
      com.example.x: "1"
    ports:
      - target: 80
        published: \${WEB_PORT}
        host_ip: \${BIND}
      - "\${BIND}:\${DNS_PORT}:53/udp"
    volumes:
      - db:/var/lib/db
      - type: bind
        source: ./data/html
        target: /html
        read_only: true
      - type: tmpfs
        target: /tmp
    networks: [internal]
    network_mode: bridge
volumes:
  db: {}
networks:
  internal:
    driver: bridge
    internal: true
configs:
  site:
    file: ./data/site.conf
x-note: frei
`;
    expect(check(text)).toEqual([]);
  });
});

describe('compose safety check: every forbidden option', () => {
  it.each([
    ['privileged: true', 'privileged'],
    ['privileged: false', 'privileged'],
    ['cap_add: [NET_ADMIN]', 'cap_add'],
    ['devices: ["/dev/sda:/dev/sda"]', 'devices'],
    ['gpus: all', 'devices'],
    ['device_cgroup_rules: ["c 1:3 mr"]', 'devices'],
    ['network_mode: host', 'network_mode'],
    ['network_mode: "container:hz-core"', 'network_mode'],
    ['network_mode: ${MODE}', 'network_mode'],
    ['pid: host', 'pid'],
    ['pid: "service:other"', 'pid'],
    ['ipc: host', 'ipc'],
    ['userns_mode: host', 'userns_mode'],
    ['uts: host', 'uts'],
    ['cgroup: host', 'cgroup'],
    ['security_opt: ["apparmor:unconfined"]', 'security_opt'],
    ['build: .', 'build'],
    ['extends: { service: x }', 'extends'],
    ['volumes_from: [hz-core]', 'volumes_from'],
    ['external_links: [hz-core]', 'external_links'],
    ['runtime: runc', 'runtime'],
    ['post_start: [{ command: id, privileged: true }]', 'post_start'],
    ['container_name: hz-core', 'container_name'],
    ['container_name: ${APP_ID}x', 'container_name'],
    ['labels: { hz.role: core }', 'hz.role'],
    ['labels: ["hz.role=agent"]', 'hz.role'],
    ['labels: { HZ.ROLE: core }', 'hz.role'],
    ['labels: { homelab.app: other }', 'homelab.app'],
    ['labels: { homelab.game: mc }', 'reserviert'],
    ['labels: { com.docker.compose.project.working_dir: /opt/homelab/apps/x }', 'reserviert'],
    ['deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } }', 'devices'],
    ['logging: { driver: syslog }', 'logging'],
    ['mac_address: "02:42:ac:11:00:02"', 'mac_address'],
    ['oom_score_adj: -1000', 'oom_score_adj'],
    ['oom_score_adj: 100', 'oom_score_adj'],
    ['env_file: ../secrets.env', 'env_file'],
    ['env_file: [/etc/environment]', 'env_file'],
  ])('refuses %s', (line, fragment) => {
    expectRefused(svc(line), fragment);
  });

  it.each([
    ['- /var/run/docker.sock:/var/run/docker.sock', 'docker.sock'],
    ['- ./data/docker.sock:/var/run/docker.sock', 'docker.sock'],
    ['- /etc:/host-etc', 'Bind-Mount'],
  ])('refuses volume %s', (line, fragment) => {
    expectRefused(svc(`volumes:\n  ${line}`), fragment);
  });

  it('refuses docker.sock anywhere (environment)', () => {
    expectRefused(svc('environment:\n  DOCKER_HOST: unix:///var/run/docker.sock'), 'docker.sock');
  });

  it.each([
    '"8080:80"',
    '"0.0.0.0:${WEB_PORT}:80"',
    '"127.0.0.1:${WEB_PORT}:80"',
    '"${WEB_PORT}:80"',
    '"80"',
    '80',
    '"${BIND}:8080:80"',
    '"${BIND}:${PASS}:80"',
    '"${BIND}:${WEB_PORT}:80/udp"',
    '"${BIND}:${WEB_PORT}-${DNS_PORT}:80-81"',
    '"${BIND}:${WEB_PORT}:0"',
    '{ target: 80, published: "${WEB_PORT}" }',
    '{ target: 80, published: "${WEB_PORT}", host_ip: 0.0.0.0 }',
    '{ target: 80, published: 8080, host_ip: "${BIND}" }',
    '{ target: 80, published: "${WEB_PORT}", host_ip: "${BIND}", protocol: sctp }',
  ])('refuses port %s', (port) => {
    const text = `services:
  app:
    image: nginx:1.27
    ports:
      - ${port}
`;
    expectRefused(text);
  });

  it('refuses more than 10 services', () => {
    const many = Array.from({ length: 11 }, (_, i) => `  s${i}:\n    image: busybox:1.36\n`).join(
      '',
    );
    expectRefused(`services:\n${many}`, 'Höchstens 10');
    const ten = Array.from({ length: 10 }, (_, i) => `  s${i}:\n    image: busybox:1.36\n`).join(
      '',
    );
    expect(check(`services:\n${ten}`)).toEqual([]);
  });

  it.each([
    ['volumes:\n  db:\n    driver: local\n', 'Treiber'],
    ['volumes:\n  db:\n    driver_opts: { type: none, o: bind, device: /etc }\n', 'Treiber'],
    ['volumes:\n  db:\n    external: true\n', 'extern'],
    ['volumes:\n  db:\n    name: hz-core-data\n', 'extern'],
    ['networks:\n  n:\n    external: true\n', 'extern'],
    ['networks:\n  n:\n    name: hz_default\n', 'extern'],
    ['networks:\n  n:\n    driver: host\n', 'bridge'],
    ['networks:\n  n:\n    driver_opts: { a: b }\n', 'driver_opts'],
    ['configs:\n  c:\n    file: /etc/passwd\n', 'configs'],
    ['configs:\n  c:\n    environment: HZ_AGENT_TOKEN\n', 'configs'],
    ['secrets:\n  s:\n    file: ../../x\n', 'secrets'],
    ['secrets:\n  s:\n    external: true\n', 'secrets'],
    ['include:\n  - ../other/compose.yml\n', 'include'],
    ['name: hz\n', 'name'],
  ])('refuses top-level %s', (top, fragment) => {
    expectRefused(`${svc('')}${top}`, fragment);
  });

  it('refuses a service network that is not declared (e.g. host)', () => {
    expectRefused(svc('networks: [host]'), 'Netzwerk');
  });

  it('refuses a missing or empty services map and services without image', () => {
    expectRefused('version: "3"\n', 'services');
    expectRefused('services: {}\n', 'services');
    expectRefused('services:\n  app:\n    restart: always\n', 'image');
  });
});

describe('compose safety check: path escapes', () => {
  it.each([
    './data/../../etc',
    './data/..',
    './data/./x',
    './data//x',
    '../x',
    './../etc',
    './other',
    '.',
    './',
    'data/x',
    '/etc',
    '/opt/homelab/apps/other/data',
    '~',
    '~/x',
    '~root/.ssh',
    './data/x/../../../etc',
    '.\\data',
  ])('refuses bind source %s (short and long form)', (source) => {
    expect(isAppDataPath(source)).toBe(false);
    expectRefused(svc(`volumes:\n  - "${source}:/mnt"`));
    expectRefused(svc(`volumes:\n  - type: bind\n    source: "${source}"\n    target: /mnt`));
  });

  it.each(['./data', './data/', './data/a', './data/a.b/c_d-e'])('accepts %s', (source) => {
    expect(isAppDataPath(source)).toBe(true);
    expect(check(svc(`volumes:\n  - "${source}:/mnt"`))).toEqual([]);
  });

  it('refuses nested bind mounts (symlink planting), also across services', () => {
    expectRefused(svc('volumes:\n  - ./data:/a\n  - ./data/x:/b'), 'ineinander');
    const text = `services:
  a:
    image: busybox:1.36
    volumes: [./data/shared:/s]
  b:
    image: busybox:1.36
    volumes: [./data/shared/sub:/s]
`;
    expectRefused(text, 'ineinander');
  });

  it('refuses config/secret files below (or at) a bind-mounted folder', () => {
    const files = (f: string) =>
      `${svc('volumes:\n  - ./data/conf:/conf')}configs:\n  c:\n    file: ${f}\n`;
    expectRefused(files('./data/conf/app.ini'), 'gemounteten Ordner');
    expectRefused(files('./data/conf'), 'gemounteten Ordner');
    expectRefused(
      `${svc('volumes:\n  - ./data:/d')}secrets:\n  s:\n    file: ./data/pw.txt\n`,
      'gemounteten Ordner',
    );
    expect(check(files('./data/other.ini'))).toEqual([]);
  });

  it('refuses placeholders in volumes, propagation and volume subpath escapes', () => {
    expectRefused(svc('volumes:\n  - ${APP_DIR}:/a'), 'Platzhalter');
    expectRefused(svc('volumes:\n  - ./data/${MODE}:/a'), 'Platzhalter');
    expectRefused(
      svc(
        'volumes:\n  - type: bind\n    source: ./data\n    target: /a\n    bind: { propagation: rshared }',
      ),
      'propagation',
    );
    expectRefused(
      `services:
  app:
    image: busybox:1.36
    volumes:
      - type: volume
        source: db
        target: /a
        volume: { subpath: ../../x }
volumes:
  db:
`,
      'subpath',
    );
    expectRefused(svc('volumes:\n  - undeclared:/a'), 'benanntes Volume');
    expectRefused(svc('volumes:\n  - type: npipe\n    source: x\n    target: /a'), 'Volume-Typ');
  });
});

describe('compose safety check: YAML tricks', () => {
  it('refuses anchors and aliases', () => {
    expectRefused(
      `x-base: &base
  image: busybox:1.36
services:
  app: *base
`,
      'Anker',
    );
  });

  it('refuses merge keys (could smuggle privileged)', () => {
    expectRefused(
      `x-evil: { privileged: true }
services:
  app:
    <<: {privileged: true}
    image: busybox:1.36
`,
      'Merge',
    );
  });

  it.each(['!!str', '!reset', '!override', '!!binary', '!custom'])('refuses tag %s', (tag) => {
    expectRefused(`services:\n  app:\n    image: busybox:1.36\n    ports: ${tag} []\n`, 'Tags');
  });

  it('refuses several documents, duplicate keys, non-string keys and bad YAML', () => {
    expectRefused(
      `${svc('')}---\nservices:\n  x:\n    image: a\n    privileged: true\n`,
      'Dokument',
    );
    expectRefused(
      'services:\n  app:\n    image: busybox:1.36\n    image: other\n',
      'gültiges YAML',
    );
    expectRefused('services:\n  1:\n    image: busybox:1.36\n', 'Schlüssel');
    expectRefused('services: [\n', 'YAML');
  });

  it('sees flow style and quoted keys the same as block style', () => {
    expectRefused('{services: {app: {image: busybox, "privileged": true}}}', 'privileged');
    expectRefused("services:\n  app:\n    image: busybox\n    'cap_add': [ALL]\n", 'cap_add');
  });

  it('refuses oversize files, NUL and deep nesting', () => {
    expectRefused(`${svc('')}# ${'x'.repeat(APP_COMPOSE_MAX_BYTES)}\n`, 'größer');
    expectRefused(`${svc('')}\0`, 'NUL');
    let deep = 'x';
    for (let i = 0; i < 40; i += 1) deep = `[${deep}]`;
    expectRefused(svc(`environment: { A: "1" }\ncommand: ${deep}`), 'verschachtelt');
  });
});

describe('compose safety check: placeholders', () => {
  it.each([
    ['environment: { T: $HZ_AGENT_TOKEN }', 'Ungültiges $'],
    ['environment: { T: "${HZ_AGENT_TOKEN}" }', 'Unbekannter Platzhalter'],
    ['environment: { T: "${PASS:-default}" }', 'Ungültiges $'],
    ['environment: { T: "${PASS?err}" }', 'Ungültiges $'],
    ['environment: ["${PASS}=x", "A=$"]', 'Ungültiges $'],
    ['environment: { "${PASS}": x }', 'Schlüsseln'],
  ])('refuses %s', (line, fragment) => {
    expectRefused(svc(line), fragment);
  });

  it('accepts $$ and known placeholders', () => {
    expect(check(svc('environment: { A: "$$HOME", B: "${PASS}", C: "${TZ}" }'))).toEqual([]);
  });
});
