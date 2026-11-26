import { APP_COMPOSE_MAX_BYTES } from '@hz/shared';
import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';

/**
 * Compose safety check of a stack template (packages/shared/src/api/apps.ts,
 * COMPOSE_FORBIDDEN). Pure function: compose.yml text in, German problems out
 * (empty = safe). Runs on built-in and custom templates and again on the
 * rendered file the core writes to the server.
 *
 * The check is an allowlist: only known harmless keys pass, everything else
 * (also future Compose options) is refused. YAML anchors, aliases, merge keys,
 * explicit tags and multiple documents are refused, so the structure checked
 * here is exactly the structure Compose sees. Every `$` must be `$$` or a
 * known `${KEY}`: Compose would otherwise fill `$NAME` from the agent's
 * environment (the agent token) or from shell defaults (`${X:-...}`).
 */

export type PortProto = 'tcp' | 'udp';

export interface ComposeCheckOptions {
  /** Placeholders the file may use (reserved keys and parameter keys). */
  keys: ReadonlySet<string>;
  /** Port parameters (key -> protocol): the only allowed host ports. */
  portKeys: ReadonlyMap<string, PortProto>;
  /** Rendered file: label `homelab.app` is allowed with exactly this value. */
  appId?: string;
}

export interface PublishedPort {
  key: string;
  protocol: PortProto;
}

export interface ComposeAnalysis {
  problems: string[];
  /** Host ports the file publishes (port parameter keys). */
  published: PublishedPort[];
  /** Service names (in file order). */
  services: string[];
}

export const MAX_SERVICES = 10;
const MAX_DEPTH = 24;
const MAX_NODES = 20_000;
const MAX_PROBLEMS = 40;

const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const RESOURCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const PRINTABLE_KEY_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const PLACEHOLDER_RE = /^\$\{([A-Z][A-Z0-9_]*)\}/;
/** ./data or ./data/<seg>/... with plain segments. */
const DATA_PATH_RE = /^\.\/data(?:\/[A-Za-z0-9_.-]+)*\/?$/;
const SHORT_PORT_RE = /^\$\{BIND\}:\$\{([A-Z][A-Z0-9_]*)\}:(\d{1,5})(?:\/(tcp|udp))?$/;
const VOLUME_MODE_RE =
  /^(?:ro|rw|z|Z|cached|delegated|consistent|nocopy)(?:,(?:ro|rw|z|Z|cached|delegated|consistent|nocopy))*$/;
const CONTAINER_NAME_RE = /^\$\{APP_ID\}(?:-[a-z0-9][a-z0-9_.-]{0,30})?$/;

/** Service keys that are harmless for the host (no further check needed beyond the generic one). */
const PLAIN_SERVICE_KEYS = new Set([
  'image',
  'restart',
  'command',
  'entrypoint',
  'healthcheck',
  'depends_on',
  'user',
  'working_dir',
  'hostname',
  'domainname',
  'expose',
  'stop_signal',
  'stop_grace_period',
  'tmpfs',
  'ulimits',
  'mem_limit',
  'mem_reservation',
  'memswap_limit',
  'mem_swappiness',
  'cpus',
  'cpu_shares',
  'cpu_count',
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpuset',
  'shm_size',
  'init',
  'read_only',
  'tty',
  'stdin_open',
  'extra_hosts',
  'dns',
  'dns_opt',
  'dns_search',
  'sysctls',
  'platform',
  'pull_policy',
  'profiles',
  'oom_kill_disable',
  'pids_limit',
  'group_add',
  'cap_drop',
  'links',
  'configs',
  'secrets',
  'attach',
  'annotations',
  'scale',
]);

/** Keys with a fixed German problem (COMPOSE_FORBIDDEN and close relatives). */
const FORBIDDEN_SERVICE_KEYS: Record<string, string> = {
  privileged: 'privileged ist nicht erlaubt',
  cap_add: 'cap_add ist nicht erlaubt',
  devices: 'devices ist nicht erlaubt',
  device_cgroup_rules: 'devices ist nicht erlaubt (device_cgroup_rules)',
  gpus: 'devices ist nicht erlaubt (gpus)',
  security_opt: 'security_opt ist nicht erlaubt',
  build: 'build ist nicht erlaubt (nur fertige Images)',
  extends: 'extends ist nicht erlaubt',
  pid: 'pid ist nicht erlaubt (pid: host)',
  userns_mode: 'userns_mode ist nicht erlaubt (userns_mode: host)',
  uts: 'uts ist nicht erlaubt (Host-Namespace)',
  cgroup: 'cgroup ist nicht erlaubt (Host-Namespace)',
  cgroup_parent: 'cgroup_parent ist nicht erlaubt',
  volumes_from: 'volumes_from ist nicht erlaubt',
  external_links: 'external_links ist nicht erlaubt',
  runtime: 'runtime ist nicht erlaubt',
  isolation: 'isolation ist nicht erlaubt',
  storage_opt: 'storage_opt ist nicht erlaubt',
  post_start: 'post_start ist nicht erlaubt',
  pre_stop: 'pre_stop ist nicht erlaubt',
  develop: 'develop ist nicht erlaubt',
  credential_spec: 'credential_spec ist nicht erlaubt',
};

const TOP_KEYS = new Set(['version', 'services', 'volumes', 'networks', 'configs', 'secrets']);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class Problems {
  private readonly set = new Set<string>();
  add(text: string): void {
    if (this.set.size < MAX_PROBLEMS) this.set.add(text.slice(0, 300));
  }
  list(): string[] {
    return [...this.set];
  }
}

const keyText = (k: string): string => (PRINTABLE_KEY_RE.test(k) ? k : '(ungültiger Name)');

/** Bind-mount source rule: ./data or below, no `.`/`..` segments, no `//`. */
export function isAppDataPath(p: string): boolean {
  if (!DATA_PATH_RE.test(p) || p.includes('//')) return false;
  return !p
    .split('/')
    .slice(1)
    .some((seg) => seg === '.' || seg === '..');
}

function normalizeDataPath(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Parses the YAML strictly. Returns the plain tree or problems. Refuses
 * anchors, aliases, merge keys, explicit tags, non-string keys, `$` in keys,
 * several documents, too deep or too large trees.
 */
function parseStrict(text: string, problems: Problems): Json | undefined {
  if (Buffer.byteLength(text, 'utf8') > APP_COMPOSE_MAX_BYTES) {
    problems.add(`Compose-Datei ist größer als ${APP_COMPOSE_MAX_BYTES / 1024} KiB`);
    return undefined;
  }
  if (text.includes('\0')) {
    problems.add('Compose-Datei enthält ein NUL-Zeichen');
    return undefined;
  }
  let docs;
  try {
    docs = parseAllDocuments(text, {
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      version: '1.2',
      schema: 'core',
    });
  } catch {
    problems.add('Compose-Datei ist kein gültiges YAML');
    return undefined;
  }
  if (!Array.isArray(docs) || docs.length !== 1) {
    problems.add('Compose-Datei muss genau ein YAML-Dokument enthalten');
    return undefined;
  }
  const doc = docs[0];
  if (!doc || doc.errors.length > 0) {
    problems.add('Compose-Datei ist kein gültiges YAML');
    return undefined;
  }
  let bad = false;
  let nodes = 0;
  visit(doc, {
    Node(_key, node) {
      nodes += 1;
      if (nodes > MAX_NODES) {
        problems.add('Compose-Datei ist zu groß (zu viele Einträge)');
        bad = true;
        return visit.BREAK;
      }
      if (isAlias(node)) {
        problems.add('YAML-Aliase (*name) sind nicht erlaubt');
        bad = true;
        return undefined;
      }
      if ('anchor' in node && typeof node.anchor === 'string' && node.anchor !== '') {
        problems.add('YAML-Anker (&name) sind nicht erlaubt');
        bad = true;
      }
      if ('tag' in node && typeof node.tag === 'string' && node.tag !== '') {
        problems.add('YAML-Tags (!tag) sind nicht erlaubt');
        bad = true;
      }
      return undefined;
    },
    Pair(_key, pair) {
      const k = pair.key;
      if (!isScalar(k) || typeof k.value !== 'string') {
        problems.add('Schlüssel müssen Texte sein');
        bad = true;
        return undefined;
      }
      if (k.value === '<<') {
        problems.add('YAML-Merge-Keys (<<) sind nicht erlaubt');
        bad = true;
      }
      if (k.value.includes('$')) {
        problems.add('Platzhalter in Schlüsseln sind nicht erlaubt');
        bad = true;
      }
      return undefined;
    },
  });
  if (bad) return undefined;
  const root = doc.contents;
  if (!isMap(root)) {
    problems.add('Compose-Datei muss eine Zuordnung (services: …) sein');
    return undefined;
  }
  // Depth check on the AST before converting.
  const depthOk = (n: unknown, d: number): boolean => {
    if (d > MAX_DEPTH) return false;
    if (isMap(n)) return n.items.every((p) => isPair(p) && depthOk(p.value, d + 1));
    if (isSeq(n)) return n.items.every((i) => depthOk(i, d + 1));
    return true;
  };
  if (!depthOk(root, 0)) {
    problems.add('Compose-Datei ist zu tief verschachtelt');
    return undefined;
  }
  return doc.toJS({ maxAliasCount: 0 }) as Json;
}

/** Every string in the tree: only `$$` and known `${KEY}`; no docker.sock anywhere. */
function scanStrings(v: Json, keys: ReadonlySet<string>, problems: Problems): void {
  if (typeof v === 'string') {
    if (/docker\.sock/i.test(v)) problems.add('Docker-Socket (docker.sock) ist nicht erlaubt');
    for (let i = v.indexOf('$'); i !== -1; i = v.indexOf('$', i)) {
      if (v[i + 1] === '$') {
        i += 2;
        continue;
      }
      const m = PLACEHOLDER_RE.exec(v.slice(i));
      if (!m?.[1]) {
        problems.add('Ungültiges $: nur ${NAME} oder $$ erlaubt');
        break;
      }
      if (!keys.has(m[1])) problems.add(`Unbekannter Platzhalter \${${m[1].slice(0, 40)}}`);
      i += m[0].length;
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) scanStrings(item, keys, problems);
    return;
  }
  if (isObj(v)) {
    for (const [k, item] of Object.entries(v)) {
      if (/docker\.sock/i.test(k)) problems.add('Docker-Socket (docker.sock) ist nicht erlaubt');
      scanStrings(item, keys, problems);
    }
  }
}

function hasKeyDeep(v: Json, key: string): boolean {
  if (Array.isArray(v)) return v.some((i) => hasKeyDeep(i, key));
  if (isObj(v)) return Object.entries(v).some(([k, i]) => k === key || hasKeyDeep(i, key));
  return false;
}

interface ServiceCtx {
  name: string;
  problems: Problems;
  opts: ComposeCheckOptions;
  namedVolumes: ReadonlySet<string>;
  networks: ReadonlySet<string>;
  binds: string[];
  published: PublishedPort[];
}

const svc = (c: ServiceCtx, text: string): void => c.problems.add(`Dienst „${c.name}“: ${text}`);

function checkLabels(c: ServiceCtx, v: Json): void {
  const pairs: [string, Json][] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== 'string') {
        svc(c, 'labels als Liste nur mit Texten (key=value)');
        continue;
      }
      const eq = item.indexOf('=');
      pairs.push(eq === -1 ? [item, ''] : [item.slice(0, eq), item.slice(eq + 1)]);
    }
  } else if (isObj(v)) {
    pairs.push(...Object.entries(v));
  } else if (v !== null) {
    svc(c, 'labels muss eine Zuordnung oder Liste sein');
    return;
  }
  for (const [rawKey, value] of pairs) {
    const k = rawKey.trim().toLowerCase();
    if (k === 'hz.role') {
      svc(c, 'Label hz.role ist nicht erlaubt');
    } else if (k === 'homelab.app') {
      if (c.opts.appId === undefined || value !== c.opts.appId) {
        svc(c, 'Label homelab.app setzt die Zentrale selbst');
      }
    } else if (k.startsWith('hz.') || k.startsWith('homelab.') || k.startsWith('com.docker.')) {
      svc(c, `Label ${keyText(rawKey)} ist reserviert`);
    }
  }
}

function checkPorts(c: ServiceCtx, v: Json): void {
  if (!Array.isArray(v)) {
    svc(c, 'ports muss eine Liste sein');
    return;
  }
  for (const p of v) {
    let key: string | undefined;
    let target: number | undefined;
    let protocol: PortProto;
    if (typeof p === 'string' || typeof p === 'number') {
      const m = SHORT_PORT_RE.exec(String(p));
      if (!m?.[1] || !m[2]) {
        svc(c, 'Port ohne ${BIND} als Host-IP oder ohne Port-Parameter (Form: ${BIND}:${PORT}:80)');
        continue;
      }
      key = m[1];
      target = Number(m[2]);
      protocol = m[3] === 'udp' ? 'udp' : 'tcp';
    } else if (isObj(p)) {
      const allowed = new Set([
        'target',
        'published',
        'host_ip',
        'protocol',
        'mode',
        'name',
        'app_protocol',
      ]);
      if (Object.keys(p).some((k) => !allowed.has(k))) {
        svc(c, 'Port mit nicht erlaubter Option');
        continue;
      }
      if (p.host_ip !== '${BIND}') {
        svc(c, 'Port ohne ${BIND} als host_ip');
        continue;
      }
      const pub =
        typeof p.published === 'string' ? /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(p.published) : null;
      if (!pub?.[1]) {
        svc(c, 'published muss ein Port-Parameter sein (${PORT})');
        continue;
      }
      key = pub[1];
      const t =
        typeof p.target === 'string' && /^\d{1,5}$/.test(p.target) ? Number(p.target) : p.target;
      target = typeof t === 'number' ? t : undefined;
      if (p.protocol !== undefined && p.protocol !== 'tcp' && p.protocol !== 'udp') {
        svc(c, 'Port-Protokoll nur tcp oder udp');
        continue;
      }
      protocol = p.protocol === 'udp' ? 'udp' : 'tcp';
    } else {
      svc(c, 'ungültiger Port-Eintrag');
      continue;
    }
    if (target === undefined || !Number.isInteger(target) || target < 1 || target > 65535) {
      svc(c, 'Container-Port muss eine Zahl von 1 bis 65535 sein');
      continue;
    }
    const want = c.opts.portKeys.get(key);
    if (want === undefined) {
      svc(c, `Host-Port \${${key.slice(0, 40)}} ist kein Port-Parameter`);
      continue;
    }
    if (want !== protocol) {
      svc(c, `Port \${${key}} ist als ${want} angelegt, wird aber als ${protocol} veröffentlicht`);
      continue;
    }
    c.published.push({ key, protocol });
  }
}

function checkBindSource(c: ServiceCtx, source: string): void {
  if (!isAppDataPath(source)) {
    svc(c, 'Bind-Mount nur unter ./data/ (keine absoluten Pfade, kein ~, kein ..)');
    return;
  }
  c.binds.push(normalizeDataPath(source));
}

function checkVolumes(c: ServiceCtx, v: Json): void {
  if (!Array.isArray(v)) {
    svc(c, 'volumes muss eine Liste sein');
    return;
  }
  for (const vol of v) {
    if (typeof vol === 'string') {
      if (vol.includes('$')) {
        svc(c, 'Platzhalter in volumes sind nicht erlaubt');
        continue;
      }
      const parts = vol.split(':');
      if (parts.length > 3 || parts.some((x) => x === '')) {
        svc(c, 'ungültiger Volume-Eintrag');
        continue;
      }
      const [first = '', second, mode] = parts;
      if (second === undefined) {
        // Anonymous volume: only a container path.
        if (!first.startsWith('/')) svc(c, 'ungültiger Volume-Eintrag');
        continue;
      }
      if (!second.startsWith('/')) svc(c, 'Volume-Ziel muss ein absoluter Container-Pfad sein');
      if (mode !== undefined && !VOLUME_MODE_RE.test(mode)) svc(c, 'ungültige Volume-Option');
      if (/^[./~]/.test(first) || first.includes('/') || first.includes('\\')) {
        checkBindSource(c, first);
      } else if (!RESOURCE_NAME_RE.test(first) || !c.namedVolumes.has(first)) {
        svc(c, 'benanntes Volume ist nicht unter volumes: angelegt');
      }
      continue;
    }
    if (!isObj(vol)) {
      svc(c, 'ungültiger Volume-Eintrag');
      continue;
    }
    if (hasDollar(vol)) {
      svc(c, 'Platzhalter in volumes sind nicht erlaubt');
      continue;
    }
    const allowed = new Set([
      'type',
      'source',
      'target',
      'read_only',
      'bind',
      'volume',
      'tmpfs',
      'consistency',
    ]);
    if (Object.keys(vol).some((k) => !allowed.has(k))) {
      svc(c, 'Volume mit nicht erlaubter Option');
      continue;
    }
    if (typeof vol.target !== 'string' || !vol.target.startsWith('/')) {
      svc(c, 'Volume-Ziel muss ein absoluter Container-Pfad sein');
      continue;
    }
    switch (vol.type) {
      case 'bind': {
        if (typeof vol.source !== 'string') {
          svc(c, 'Bind-Mount ohne source');
          break;
        }
        if (vol.bind !== undefined) {
          const b = vol.bind;
          const okKeys = new Set(['create_host_path', 'selinux']);
          if (!isObj(b) || Object.keys(b).some((k) => !okKeys.has(k))) {
            svc(c, 'Bind-Mount-Option nicht erlaubt (z. B. propagation)');
          }
        }
        if (vol.volume !== undefined || vol.tmpfs !== undefined)
          svc(c, 'ungültiger Volume-Eintrag');
        checkBindSource(c, vol.source);
        break;
      }
      case 'volume': {
        if (vol.source !== undefined) {
          if (typeof vol.source !== 'string' || !c.namedVolumes.has(vol.source)) {
            svc(c, 'benanntes Volume ist nicht unter volumes: angelegt');
          }
        }
        if (vol.volume !== undefined) {
          const o = vol.volume;
          const okKeys = new Set(['nocopy', 'subpath']);
          if (!isObj(o) || Object.keys(o).some((k) => !okKeys.has(k))) {
            svc(c, 'Volume-Option nicht erlaubt');
          } else if (
            o.subpath !== undefined &&
            (typeof o.subpath !== 'string' ||
              o.subpath.startsWith('/') ||
              o.subpath.split('/').some((s) => s === '..'))
          ) {
            svc(c, 'subpath darf nicht aus dem Volume führen');
          }
        }
        if (vol.bind !== undefined || vol.tmpfs !== undefined) svc(c, 'ungültiger Volume-Eintrag');
        break;
      }
      case 'tmpfs':
        if (vol.source !== undefined || vol.bind !== undefined || vol.volume !== undefined) {
          svc(c, 'ungültiger Volume-Eintrag');
        }
        break;
      default:
        svc(c, 'Volume-Typ nur bind, volume oder tmpfs');
    }
  }
}

function hasDollar(v: Json): boolean {
  if (typeof v === 'string') return v.includes('$');
  if (Array.isArray(v)) return v.some(hasDollar);
  if (isObj(v)) return Object.values(v).some(hasDollar);
  return false;
}

function checkEnvFile(c: ServiceCtx, v: Json): void {
  const items = Array.isArray(v) ? v : [v];
  for (const item of items) {
    if (item === '.env' || item === './.env') continue;
    if (
      isObj(item) &&
      (item.path === '.env' || item.path === './.env') &&
      Object.keys(item).every((k) => k === 'path' || k === 'required' || k === 'format')
    ) {
      continue;
    }
    svc(c, 'env_file nur .env');
  }
}

function checkServiceNetworks(c: ServiceCtx, v: Json): void {
  const names: string[] = [];
  if (Array.isArray(v)) {
    for (const n of v) {
      if (typeof n === 'string') names.push(n);
      else svc(c, 'ungültiger Netzwerk-Eintrag');
    }
  } else if (isObj(v)) {
    const okKeys = new Set(['aliases', 'ipv4_address', 'ipv6_address', 'priority', 'gw_priority']);
    for (const [n, opts] of Object.entries(v)) {
      names.push(n);
      if (opts !== null && (!isObj(opts) || Object.keys(opts).some((k) => !okKeys.has(k)))) {
        svc(c, 'Netzwerk-Option nicht erlaubt');
      }
    }
  } else {
    svc(c, 'networks muss eine Liste oder Zuordnung sein');
  }
  for (const n of names) {
    if (n !== 'default' && !c.networks.has(n)) {
      svc(c, 'Netzwerk ist nicht unter networks: angelegt');
    }
  }
}

function checkService(c: ServiceCtx, s: Json): void {
  if (!isObj(s)) {
    svc(c, 'muss eine Zuordnung sein');
    return;
  }
  if (typeof s.image !== 'string' || s.image.trim() === '') svc(c, 'braucht ein image');
  for (const [k, v] of Object.entries(s)) {
    if (k.startsWith('x-')) continue;
    const forbidden = FORBIDDEN_SERVICE_KEYS[k];
    if (forbidden !== undefined) {
      svc(c, forbidden);
      continue;
    }
    if (PLAIN_SERVICE_KEYS.has(k)) continue;
    switch (k) {
      case 'network_mode':
        if (v !== 'bridge' && v !== 'none') {
          svc(c, 'network_mode ist nicht erlaubt (network_mode: host; nur bridge oder none)');
        }
        break;
      case 'ipc':
        if (v !== 'private' && v !== 'shareable' && v !== 'none') {
          svc(c, 'ipc ist nicht erlaubt (ipc: host; nur private, shareable oder none)');
        }
        break;
      case 'container_name':
        if (typeof v !== 'string' || !CONTAINER_NAME_RE.test(v)) {
          svc(c, 'container_name nur ${APP_ID} oder ${APP_ID}-name');
        }
        break;
      case 'labels':
        checkLabels(c, v);
        break;
      case 'ports':
        checkPorts(c, v);
        break;
      case 'volumes':
        checkVolumes(c, v);
        break;
      case 'env_file':
        checkEnvFile(c, v);
        break;
      case 'environment':
        if (!Array.isArray(v) && !isObj(v))
          svc(c, 'environment muss eine Zuordnung oder Liste sein');
        break;
      case 'networks':
        checkServiceNetworks(c, v);
        break;
      case 'deploy':
        if (hasKeyDeep(v, 'devices')) svc(c, 'devices ist nicht erlaubt (deploy)');
        break;
      case 'logging':
        if (
          !isObj(v) ||
          (v.driver !== undefined &&
            v.driver !== 'json-file' &&
            v.driver !== 'local' &&
            v.driver !== 'none')
        ) {
          svc(c, 'logging nur mit json-file, local oder none');
        }
        break;
      default:
        svc(c, `Option ${keyText(k)} ist nicht erlaubt`);
    }
  }
}

function checkTopVolumes(v: Json, problems: Problems): Set<string> {
  const names = new Set<string>();
  if (v === undefined || v === null) return names;
  if (!isObj(v)) {
    problems.add('volumes: muss eine Zuordnung sein');
    return names;
  }
  for (const [name, def] of Object.entries(v)) {
    if (!RESOURCE_NAME_RE.test(name)) {
      problems.add('ungültiger Volume-Name');
      continue;
    }
    names.add(name);
    if (def === null) continue;
    if (!isObj(def)) {
      problems.add(`Volume „${name}“: ungültige Definition`);
      continue;
    }
    for (const k of Object.keys(def)) {
      if (k === 'labels') continue;
      if (k === 'driver' || k === 'driver_opts') {
        problems.add(`Volume „${name}“: Volume-Treiberoptionen sind nicht erlaubt`);
      } else if (k === 'external' || k === 'name') {
        problems.add(`Volume „${name}“: externe oder fremd benannte Volumes sind nicht erlaubt`);
      } else {
        problems.add(`Volume „${name}“: Option ${keyText(k)} ist nicht erlaubt`);
      }
    }
  }
  return names;
}

function checkTopNetworks(v: Json, problems: Problems): Set<string> {
  const names = new Set<string>();
  if (v === undefined || v === null) return names;
  if (!isObj(v)) {
    problems.add('networks: muss eine Zuordnung sein');
    return names;
  }
  for (const [name, def] of Object.entries(v)) {
    if (!RESOURCE_NAME_RE.test(name)) {
      problems.add('ungültiger Netzwerk-Name');
      continue;
    }
    names.add(name);
    if (def === null) continue;
    if (!isObj(def)) {
      problems.add(`Netzwerk „${name}“: ungültige Definition`);
      continue;
    }
    for (const [k, val] of Object.entries(def)) {
      if (k === 'labels' || k === 'internal' || k === 'enable_ipv6' || k === 'attachable') continue;
      if (k === 'driver') {
        if (val !== 'bridge') problems.add(`Netzwerk „${name}“: nur driver bridge`);
      } else if (k === 'external' || k === 'name') {
        problems.add(
          `Netzwerk „${name}“: externe oder fremd benannte Netzwerke sind nicht erlaubt`,
        );
      } else {
        problems.add(`Netzwerk „${name}“: Option ${keyText(k)} ist nicht erlaubt`);
      }
    }
  }
  return names;
}

function checkTopFiles(
  kind: 'configs' | 'secrets',
  v: Json,
  problems: Problems,
  files: string[],
): void {
  if (v === undefined || v === null) return;
  if (!isObj(v)) {
    problems.add(`${kind}: muss eine Zuordnung sein`);
    return;
  }
  for (const [name, def] of Object.entries(v)) {
    const label = RESOURCE_NAME_RE.test(name) ? name : '(ungültiger Name)';
    const ok =
      isObj(def) &&
      Object.keys(def).length === 1 &&
      ((typeof def.file === 'string' && isAppDataPath(def.file)) ||
        (kind === 'configs' && typeof def.content === 'string'));
    if (!ok) {
      problems.add(
        `${kind} „${label}“: nur file unter ./data/ (oder content), kein external/environment`,
      );
    } else if (typeof def.file === 'string') {
      files.push(normalizeDataPath(def.file));
    }
  }
}

/** Full analysis; see the module comment. */
export function analyzeCompose(text: string, opts: ComposeCheckOptions): ComposeAnalysis {
  const problems = new Problems();
  const tree = parseStrict(text, problems);
  if (tree === undefined || !isObj(tree)) {
    return { problems: problems.list(), published: [], services: [] };
  }
  scanStrings(tree, opts.keys, problems);
  for (const k of Object.keys(tree)) {
    if (TOP_KEYS.has(k) || k.startsWith('x-')) continue;
    if (k === 'include') problems.add('include ist nicht erlaubt');
    else if (k === 'name') problems.add('name (Projektname) ist nicht erlaubt');
    else problems.add(`Option ${keyText(k)} ist nicht erlaubt`);
  }
  const namedVolumes = checkTopVolumes(tree.volumes ?? null, problems);
  const networks = checkTopNetworks(tree.networks ?? null, problems);
  const files: string[] = [];
  checkTopFiles('configs', tree.configs ?? null, problems, files);
  checkTopFiles('secrets', tree.secrets ?? null, problems, files);

  const services = tree.services;
  const names: string[] = [];
  const published: PublishedPort[] = [];
  if (!isObj(services) || Object.keys(services).length === 0) {
    problems.add('services: fehlt oder ist leer');
  } else {
    const entries = Object.entries(services);
    if (entries.length > MAX_SERVICES) problems.add(`Höchstens ${MAX_SERVICES} Dienste erlaubt`);
    const binds: string[] = [];
    for (const [name, s] of entries) {
      if (!SERVICE_NAME_RE.test(name)) {
        problems.add('ungültiger Dienstname');
        continue;
      }
      names.push(name);
      checkService({ name, problems, opts, namedVolumes, networks, binds, published }, s);
    }
    // A container that may write ./data/a could plant a symlink at ./data/a/b, which
    // Docker would follow when it mounts ./data/a/b for another mount. No nesting.
    const unique = [...new Set(binds)];
    for (const a of unique) {
      for (const b of unique) {
        if (a !== b && b.startsWith(`${a}/`)) {
          problems.add('Bind-Mounts dürfen nicht ineinander liegen (z. B. ./data und ./data/x)');
        }
      }
    }
    // Same for config/secret files: a container could replace a file below its
    // mounted folder with a symlink that Docker then follows.
    for (const f of new Set(files)) {
      if (unique.some((b) => f === b || f.startsWith(`${b}/`) || b.startsWith(`${f}/`))) {
        problems.add('configs/secrets-Dateien dürfen nicht in einem gemounteten Ordner liegen');
      }
    }
    const seen = new Set<string>();
    for (const p of published) {
      const k = `${p.protocol}/${p.key}`;
      if (seen.has(k)) problems.add(`Port \${${p.key}} wird mehrfach veröffentlicht`);
      seen.add(k);
    }
  }
  return { problems: problems.list(), published, services: names };
}

/** German problems of a compose file (empty = safe). */
export function checkCompose(text: string, opts: ComposeCheckOptions): string[] {
  return analyzeCompose(text, opts).problems;
}
