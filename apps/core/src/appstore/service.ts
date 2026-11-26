import { isIPv4 } from 'node:net';
import { and, eq } from 'drizzle-orm';
import {
  APP_CUSTOM_TEMPLATES_MAX,
  APP_LIMIT_PER_SERVER,
  APPS_ROOT,
  appTemplateMetaSchema,
  type AppBind,
  type AppPreviewResponse,
  type AppStatus,
  type AppTemplateDetail,
  type AppTemplateMeta,
  type AppTemplateSummary,
  type InstalledApp,
  type ListeningPort,
  type PortMapping,
} from '@hz/shared';
import type { FeatureContext } from '../features.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import {
  appTemplates,
  apps,
  containers,
  deployTargets,
  gameServers,
  servers,
  serverState,
  type AppRow,
  type ServerRow,
} from '../db/schema.js';
import { gigabytes } from '../format.js';
import { collectUsed, type UsedPorts } from '../games/ports.js';
import type { HostPort } from '../games/render.js';
import { dockerArch, rpcReason } from '../games/service.js';
import { HttpError } from '../http/errors.js';
import { timeZone } from '../timezone.js';
import { checkCompose } from './compose-check.js';
import {
  renderCompose,
  renderEnv,
  resolveValues,
  RenderError,
  type ParamValue,
  type ResolvedPort,
  type ResolvedValues,
} from './render.js';
import { checkTemplate, templateKeys, type AppTemplate } from './templates.js';

/**
 * Installed apps (M21): install from a template with compose.write + compose.up
 * into /opt/homelab/apps/<appId>/, start/stop/restart/update, remove with
 * app.remove. Work on the server runs in the background (routes answer 202);
 * one action per app at a time.
 */

export const SECRETS_AAD = 'apps.secrets';
const MIB = 1024 * 1024;
const WRITE_TIMEOUT_MS = 30_000;
const UP_TIMEOUT_MS = 15 * 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const DOWN_TIMEOUT_MS = 5 * 60_000;
const REMOVE_TIMEOUT_MS = 5 * 60_000;

export type AppAction = 'start' | 'stop' | 'restart' | 'update';

/** Request after zod (defaults applied). */
export interface InstallInput {
  templateId: string;
  serverId: string;
  appId: string;
  name: string;
  bind: AppBind;
  params: Record<string, ParamValue>;
}

interface StoredPort {
  key: string;
  port: number;
  protocol: 'tcp' | 'udp';
  label: string;
  web: boolean;
}

function parse<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export const appDir = (appId: string): string => `${APPS_ROOT}${appId}`;
/** Note of the M11 allowed-port entries (via PortAuditService.syncGame: `game:app:<appId>`). */
const portOwner = (appId: string): string => `app:${appId}`;

/** First problem as a fixed hint (≤ 200 chars, the error envelope limit). */
const hint = (problems: readonly string[]): string => {
  const text = problems.slice(0, 3).join('; ');
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
};

interface Prepared {
  template: AppTemplate;
  server: ServerRow;
  resolved: ResolvedValues;
  bindIp: string | null;
  compose: string;
  env: string;
  maskedEnv: string;
  problems: string[];
  /** Problems that are conflicts (409) rather than input errors. */
  conflicts: string[];
  /** The app folder or compose project is taken (409 exists). */
  exists: string[];
}

export class AppService {
  private readonly tracked = new Set<Promise<void>>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly ctx: FeatureContext,
    private readonly builtin: ReadonlyMap<string, AppTemplate>,
  ) {}

  // ---- templates ---------------------------------------------------------------------

  private customRows() {
    return this.ctx.db.select().from(appTemplates).all();
  }

  private customOf(id: string): AppTemplate | null {
    const row = this.ctx.db.select().from(appTemplates).where(eq(appTemplates.id, id)).get();
    if (!row) return null;
    const meta = appTemplateMetaSchema.safeParse(parse<unknown>(row.metaJson));
    if (!meta.success) return null;
    return { source: 'custom', meta: meta.data, compose: row.compose };
  }

  template(id: string): AppTemplate | null {
    return this.builtin.get(id) ?? this.customOf(id);
  }

  private installedCount(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.ctx.db.select({ t: apps.templateId, s: apps.source }).from(apps).all()) {
      const k = `${r.s}:${r.t}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  }

  templateList(): AppTemplateSummary[] {
    const counts = this.installedCount();
    const all: AppTemplate[] = [...this.builtin.values()];
    for (const row of this.customRows()) {
      const t = this.customOf(row.id);
      if (t) all.push(t);
    }
    return all.map((t) => ({
      id: t.meta.id,
      source: t.source,
      name: t.meta.name,
      description: t.meta.description,
      category: t.meta.category,
      version: t.meta.version,
      arch: t.meta.arch,
      minRamMb: t.meta.minRamMb,
      installed: counts.get(`${t.source}:${t.meta.id}`) ?? 0,
    }));
  }

  templateDetail(id: string): AppTemplateDetail {
    const t = this.template(id);
    if (!t) throw new HttpError(404, 'not_found');
    return { source: t.source, meta: t.meta, compose: t.compose };
  }

  private assertTemplateSafe(meta: AppTemplateMeta, compose: string): void {
    const problems = checkTemplate(meta, compose).problems;
    if (problems.length > 0) {
      throw new HttpError(400, 'invalid_input', undefined, `Unsichere Vorlage: ${hint(problems)}`);
    }
  }

  createCustom(meta: AppTemplateMeta, compose: string): AppTemplateDetail {
    if (this.builtin.has(meta.id)) {
      throw new HttpError(409, 'exists', undefined, 'Eine eingebaute Vorlage hat diese ID');
    }
    this.assertTemplateSafe(meta, compose);
    if (this.customRows().length >= APP_CUSTOM_TEMPLATES_MAX) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        `Höchstens ${APP_CUSTOM_TEMPLATES_MAX} eigene Vorlagen`,
      );
    }
    const now = this.ctx.now();
    try {
      this.ctx.db
        .insert(appTemplates)
        .values({
          id: meta.id,
          metaJson: JSON.stringify(meta),
          compose,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      throw new HttpError(409, 'exists', undefined, 'Eine Vorlage mit dieser ID gibt es schon');
    }
    this.audit('app.template_created', meta.id, { name: meta.name });
    return this.templateDetail(meta.id);
  }

  updateCustom(id: string, meta: AppTemplateMeta, compose: string): AppTemplateDetail {
    if (this.builtin.has(id)) {
      throw new HttpError(403, 'forbidden', undefined, 'Eingebaute Vorlagen sind nicht änderbar');
    }
    if (!this.customOf(id)) throw new HttpError(404, 'not_found');
    if (meta.id !== id) throw new HttpError(400, 'invalid_input', undefined, 'ID passt nicht');
    this.assertTemplateSafe(meta, compose);
    this.ctx.db
      .update(appTemplates)
      .set({ metaJson: JSON.stringify(meta), compose, updatedAt: this.ctx.now() })
      .where(eq(appTemplates.id, id))
      .run();
    this.audit('app.template_updated', id, { name: meta.name });
    return this.templateDetail(id);
  }

  deleteCustom(id: string): void {
    if (this.builtin.has(id)) {
      throw new HttpError(403, 'forbidden', undefined, 'Eingebaute Vorlagen sind nicht löschbar');
    }
    if (
      !this.ctx.db
        .select({ id: appTemplates.id })
        .from(appTemplates)
        .where(eq(appTemplates.id, id))
        .get()
    ) {
      throw new HttpError(404, 'not_found');
    }
    const used = this.ctx.db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.templateId, id), eq(apps.source, 'custom')))
      .get();
    if (used)
      throw new HttpError(409, 'in_use', undefined, 'Vorlage wird noch von einer App verwendet');
    this.ctx.db.delete(appTemplates).where(eq(appTemplates.id, id)).run();
    this.audit('app.template_deleted', id);
  }

  // ---- checks --------------------------------------------------------------------------

  private serverRow(id: string): ServerRow | undefined {
    return this.ctx.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  private bindIp(server: ServerRow, bind: AppBind): string | null {
    switch (bind) {
      case 'localhost':
        return '127.0.0.1';
      case 'all':
        return '0.0.0.0';
      case 'tailnet':
        return server.tailscaleIp !== null && isIPv4(server.tailscaleIp)
          ? server.tailscaleIp
          : null;
    }
  }

  /** Host ports used on the server: listeners, container ports, games, other apps. */
  private usedPorts(serverId: string, exceptAppId?: string): UsedPorts {
    const st = this.ctx.db
      .select({ listening: serverState.listeningPortsJson })
      .from(serverState)
      .where(eq(serverState.serverId, serverId))
      .get();
    const own = exceptAppId === undefined ? null : appDir(exceptAppId);
    const containerPorts = this.ctx.db
      .select({ ports: containers.portsJson, dir: containers.composeDir })
      .from(containers)
      .where(eq(containers.serverId, serverId))
      .all()
      .filter((r) => own === null || r.dir !== own)
      .flatMap((r) => parse<PortMapping[]>(r.ports) ?? []);
    const games = this.ctx.db
      .select({ ports: gameServers.portsJson, rcon: gameServers.rconPort })
      .from(gameServers)
      .where(eq(gameServers.serverId, serverId))
      .all()
      .map((g) => ({ ports: parse<HostPort[]>(g.ports) ?? [], rconPort: g.rcon }));
    const used = collectUsed({
      listening: parse<ListeningPort[]>(st?.listening ?? null) ?? [],
      containerPorts,
      games,
    });
    for (const a of this.ctx.db.select().from(apps).where(eq(apps.serverId, serverId)).all()) {
      if (a.appId === exceptAppId) continue;
      for (const p of parse<StoredPort[]>(a.portsJson) ?? []) used[p.protocol].add(p.port);
    }
    return used;
  }

  private portConflicts(
    serverId: string,
    ports: readonly ResolvedPort[],
    exceptAppId?: string,
  ): string[] {
    const used = this.usedPorts(serverId, exceptAppId);
    return ports
      .filter((p) => used[p.protocol].has(p.port))
      .map((p) => `Port ${p.port}/${p.protocol} ist auf dem Server belegt`);
  }

  /** Validates and renders an install request. Never throws for input problems. */
  private prepare(input: InstallInput): Prepared {
    const template = this.template(input.templateId);
    if (!template) throw new HttpError(404, 'not_found');
    const server = this.serverRow(input.serverId);
    if (!server) throw new HttpError(404, 'not_found');
    const problems: string[] = [];
    const conflicts: string[] = [];
    const meta = template.meta;
    problems.push(...checkTemplate(meta, template.compose).problems);

    const arch = dockerArch(server.arch);
    if (arch !== null && !meta.arch.includes(arch)) problems.push(`Läuft nicht auf ${arch}`);

    const { resolved, problems: valueProblems } = resolveValues(meta, input.params);
    problems.push(...valueProblems);

    const bindIp = this.bindIp(server, input.bind);
    if (bindIp === null) problems.push('Tailscale-IP unbekannt');

    const exists = this.folderTaken(server.id, input.appId);
    const count = this.ctx.db
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.serverId, server.id))
      .all().length;
    if (count >= APP_LIMIT_PER_SERVER)
      conflicts.push(`Höchstens ${APP_LIMIT_PER_SERVER} Apps pro Server`);
    conflicts.push(...this.portConflicts(server.id, resolved.ports));

    const { keys, portKeys } = templateKeys(meta);
    let compose = template.compose;
    let env = '';
    let maskedEnv = '';
    try {
      compose = renderCompose(template.compose, input.appId);
      problems.push(...checkCompose(compose, { keys, portKeys, appId: input.appId }));
    } catch (err) {
      if (!(err instanceof RenderError)) throw err;
      problems.push('Compose-Datei kann nicht gerendert werden');
    }
    if (valueProblems.length === 0 && bindIp !== null) {
      const ctx = { appId: input.appId, appDir: appDir(input.appId), bindIp, tz: timeZone() };
      try {
        env = renderEnv(meta, ctx, resolved);
        maskedEnv = renderEnv(meta, ctx, resolved, true);
      } catch (err) {
        if (!(err instanceof RenderError)) throw err;
        problems.push(`Wert für ${err.key} kann nicht geschrieben werden`);
      }
    }
    return {
      template,
      server,
      resolved,
      bindIp,
      compose,
      env,
      maskedEnv,
      problems: [...new Set(problems)],
      conflicts: [...new Set(conflicts)],
      exists,
    };
  }

  /**
   * Why `appId` cannot be used on the server (German, empty = free). compose
   * down --remove-orphans in /opt/homelab/apps/<appId> acts on the compose
   * project <appId>: a project of the same name (the agent's own stack, a deploy
   * target, a hand-made stack) would lose its containers. So refused: names
   * starting with `homelab`, an app of the same folder, a container of the
   * inventory with that compose project or that folder, a GitHub deploy target
   * in, above or below that folder or with the same folder name.
   */
  private folderTaken(serverId: string, appId: string): string[] {
    const out: string[] = [];
    if (appId.startsWith('homelab')) out.push('Namen mit „homelab“ sind reserviert');
    const taken = this.ctx.db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.serverId, serverId), eq(apps.appId, appId)))
      .get();
    if (taken) out.push('Diesen App-Ordner gibt es auf dem Server schon');
    const dir = appDir(appId);
    const foreign = this.ctx.db
      .select({ project: containers.composeProject, dir: containers.composeDir })
      .from(containers)
      .where(eq(containers.serverId, serverId))
      .all()
      .some((c) => c.project === appId || c.dir === dir);
    if (foreign && !taken) {
      out.push('Auf dem Server läuft schon ein Compose-Projekt mit diesem Namen');
    }
    const deploy = this.ctx.db
      .select({ path: deployTargets.path })
      .from(deployTargets)
      .where(eq(deployTargets.serverId, serverId))
      .all()
      .some((d) => {
        const path = d.path.replace(/\/+$/, '');
        return (
          path === dir ||
          path.startsWith(`${dir}/`) ||
          dir.startsWith(`${path}/`) ||
          path.split('/').pop() === appId
        );
      });
    if (deploy) out.push('Ein GitHub-Deploy-Ziel nutzt diesen Ordner oder Namen');
    return out;
  }

  /** RAM problem text (M10 reserve), or null when it fits or RAM is unknown. */
  private ramProblem(serverId: string, minRamMb: number): string | null {
    const r = this.ctx.throttle.ramCheck(serverId, minRamMb * MIB, []);
    if (r.kind !== 'insufficient') return null;
    const left = Math.max(0, r.details.freeBytes - r.details.reserveBytes);
    return `Zu wenig RAM, ${gigabytes(left)} frei`;
  }

  /** RAM reserve on every path that starts the app; holds the RAM until release(). */
  private admit(serverId: string, minRamMb: number): () => void {
    const needed = minRamMb * MIB;
    const r = this.ctx.throttle.ramCheck(serverId, needed, []);
    if (r.kind === 'insufficient') {
      const left = Math.max(0, r.details.freeBytes - r.details.reserveBytes);
      throw new HttpError(
        409,
        'insufficient_ram',
        undefined,
        `Zu wenig RAM, ${gigabytes(left)} frei`,
        r.details,
      );
    }
    return this.ctx.throttle.holdRam(serverId, needed);
  }

  preview(templateId: string, input: InstallInput): AppPreviewResponse {
    if (input.templateId !== templateId) {
      throw new HttpError(400, 'invalid_input', undefined, 'Vorlage passt nicht');
    }
    const p = this.prepare(input);
    const ram = this.ramProblem(p.server.id, p.template.meta.minRamMb);
    const problems = [...p.problems, ...p.exists, ...p.conflicts, ...(ram ? [ram] : [])].map((x) =>
      x.slice(0, 300),
    );
    if (!this.ctx.hub.isConnected(p.server.id)) problems.push('Agent offline');
    return { compose: p.compose, env: p.maskedEnv, problems };
  }

  // ---- installed apps ------------------------------------------------------------------

  row(id: string): AppRow | undefined {
    return this.ctx.db.select().from(apps).where(eq(apps.id, id)).get();
  }

  private requireRow(id: string): AppRow {
    const row = this.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  private secretsOf(row: AppRow): Record<string, string> {
    if (row.secretsEnc === null) return {};
    return parse<Record<string, string>>(this.ctx.box.decrypt(row.secretsEnc, SECRETS_AAD)) ?? {};
  }

  private containersOf(row: AppRow): InstalledApp['containers'] {
    const dir = appDir(row.appId);
    return this.ctx.db
      .select()
      .from(containers)
      .where(eq(containers.serverId, row.serverId))
      .all()
      .filter((c) =>
        c.composeDir !== null ? c.composeDir === dir : c.composeProject === row.appId,
      )
      .filter((c) => {
        // Never the core's or the agent's own containers (label hz.role).
        const info = parse<{ role?: unknown }>(c.infoJson);
        return info?.role === undefined;
      })
      .map((c) => ({
        name: c.name.slice(0, 128),
        state: c.state.slice(0, 32),
        health: c.health.slice(0, 16),
      }));
  }

  summary(row: AppRow, known?: Pick<ServerRow, 'name' | 'tailscaleIp'>): InstalledApp {
    const server = known ?? this.serverRow(row.serverId);
    const ports = parse<StoredPort[]>(row.portsJson) ?? [];
    const web = ports.find((p) => p.web);
    const ip = server?.tailscaleIp ?? null;
    // localhost: only reachable on the server itself, no link.
    const url =
      web && row.bind !== 'localhost' && ip !== null && isIPv4(ip)
        ? `http://${ip}:${web.port}`
        : null;
    const template = this.template(row.templateId);
    return {
      id: row.id,
      appId: row.appId,
      name: row.name,
      serverId: row.serverId,
      serverName: (server?.name ?? row.serverId).slice(0, 64),
      templateId: row.templateId,
      source: row.source === 'custom' ? 'custom' : 'builtin',
      templateName: (template?.meta.name ?? row.templateId).slice(0, 40),
      version: row.version,
      bind: row.bind === 'all' || row.bind === 'localhost' ? row.bind : 'tailnet',
      ports: ports.map((p) => ({ port: p.port, protocol: p.protocol, label: p.label })),
      url,
      status: row.status as AppStatus,
      params: parse<Record<string, ParamValue>>(row.paramsJson) ?? {},
      hasSecrets: row.secretsEnc !== null,
      containers: this.containersOf(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastError: row.lastError,
    };
  }

  list(): InstalledApp[] {
    const byId = new Map(
      this.ctx.db
        .select({ id: servers.id, name: servers.name, tailscaleIp: servers.tailscaleIp })
        .from(servers)
        .all()
        .map((s) => [s.id, s]),
    );
    return this.ctx.db
      .select()
      .from(apps)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id))
      .map((r) => this.summary(r, byId.get(r.serverId)));
  }

  get(id: string): InstalledApp {
    return this.summary(this.requireRow(id));
  }

  secrets(id: string): Record<string, string> {
    const row = this.requireRow(id);
    const values = this.secretsOf(row);
    this.audit('app.secrets_viewed', row.id, {
      appId: row.appId,
      keys: Object.keys(values).sort(),
    });
    return values;
  }

  install(input: InstallInput): InstalledApp {
    const p = this.prepare(input);
    if (p.problems.length > 0)
      throw new HttpError(400, 'invalid_input', undefined, hint(p.problems));
    if (p.exists.length > 0) throw new HttpError(409, 'exists', undefined, hint(p.exists));
    if (p.conflicts.length > 0) throw new HttpError(409, 'conflict', undefined, hint(p.conflicts));
    if (!this.ctx.hub.isConnected(p.server.id)) throw new HttpError(409, 'agent_offline');
    const release = this.admit(p.server.id, p.template.meta.minRamMb);

    const id = randomId();
    const now = this.ctx.now();
    const ports: StoredPort[] = p.resolved.ports.map((x) => ({ ...x }));
    try {
      this.ctx.db
        .insert(apps)
        .values({
          id,
          serverId: p.server.id,
          appId: input.appId,
          name: input.name,
          templateId: p.template.meta.id,
          source: p.template.source,
          version: p.template.meta.version,
          bind: input.bind,
          paramsJson: JSON.stringify(p.resolved.values),
          secretsEnc:
            Object.keys(p.resolved.secrets).length === 0
              ? null
              : this.ctx.box.encrypt(JSON.stringify(p.resolved.secrets), SECRETS_AAD),
          portsJson: JSON.stringify(ports),
          status: 'installing',
          lastError: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      release();
      throw new HttpError(
        409,
        'exists',
        undefined,
        'Diesen App-Ordner gibt es auf dem Server schon',
      );
    }
    this.syncPorts(p.server.id, input.appId, input.bind, ports);
    this.audit('app.installed', id, {
      appId: input.appId,
      name: input.name,
      templateId: p.template.meta.id,
      source: p.template.source,
      serverId: p.server.id,
      bind: input.bind,
      ports: ports.map((x) => ({ port: x.port, protocol: x.protocol })),
      keys: Object.keys(input.params).sort(),
    });
    const secrets = Object.values(p.resolved.secrets);
    this.run(id, async () => {
      const dir = appDir(input.appId);
      let what = 'Dateien schreiben';
      try {
        await this.ctx.hub.call(
          p.server.id,
          'compose.write',
          { dir, files: { 'compose.yml': p.compose, '.env': p.env } },
          { timeoutMs: WRITE_TIMEOUT_MS },
        );
        what = 'Container starten';
        await this.ctx.hub.call(p.server.id, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setStatus(id, 'running', null);
      } catch (err) {
        this.fail(id, 'app.install_failed', rpcReason(err, what, secrets));
      } finally {
        release();
      }
    });
    return this.get(id);
  }

  private syncPorts(
    serverId: string,
    appId: string,
    bind: string,
    ports: readonly StoredPort[],
  ): void {
    const list = bind === 'all' ? ports.map((p) => ({ port: p.port, proto: p.protocol })) : [];
    this.ctx.ports.syncGame(serverId, portOwner(appId), list);
  }

  action(id: string, action: AppAction): InstalledApp {
    const row = this.requireRow(id);
    if (this.busy.has(row.id)) throw new HttpError(409, 'busy');
    if (row.status === 'installing' || row.status === 'removing' || row.status === 'updating') {
      throw new HttpError(409, 'busy');
    }
    if (!this.ctx.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    if (action === 'update') return this.update(row);
    const dir = appDir(row.appId);
    const secrets = Object.values(this.secretsOf(row));
    const needsRam = action === 'start' && row.status !== 'running';
    const minRamMb = this.template(row.templateId)?.meta.minRamMb ?? 0;
    const release = needsRam ? this.admit(row.serverId, minRamMb) : () => undefined;
    this.audit(`app.${action}`, row.id, { appId: row.appId, name: row.name });
    this.run(row.id, async () => {
      const hub = this.ctx.hub;
      try {
        if (action === 'stop' || action === 'restart') {
          await hub.call(row.serverId, 'compose.down', { dir }, { timeoutMs: DOWN_TIMEOUT_MS });
        }
        if (action === 'stop') {
          this.setStatus(row.id, 'stopped', null);
          return;
        }
        await hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setStatus(row.id, 'running', null);
      } catch (err) {
        const what = action === 'stop' ? 'Stoppen' : 'Container starten';
        this.fail(row.id, `app.${action}_failed`, rpcReason(err, what, secrets));
      } finally {
        release();
      }
    });
    return this.get(row.id);
  }

  /**
   * Update: re-renders compose.yml/.env from the current template (new pinned
   * images) with the stored values, then compose.write, compose.pull, compose.up.
   * Without the template (custom one deleted) only pull and up.
   */
  private update(row: AppRow): InstalledApp {
    const template = this.template(row.templateId);
    const server = this.serverRow(row.serverId);
    if (!server) throw new HttpError(404, 'not_found');
    const prevSecrets = this.secretsOf(row);
    let files: { compose: string; env: string } | null = null;
    let next: { resolved: ResolvedValues; version: string } | null = null;
    if (template && template.source === row.source) {
      const prevValues = parse<Record<string, ParamValue>>(row.paramsJson) ?? {};
      const known = new Set(template.meta.params.map((p) => p.key));
      const keep = (r: Record<string, ParamValue>) =>
        Object.fromEntries(Object.entries(r).filter(([k]) => known.has(k)));
      const { resolved, problems } = resolveValues(
        template.meta,
        {},
        { values: keep(prevValues), secrets: keep(prevSecrets) as Record<string, string> },
      );
      const all = [...checkTemplate(template.meta, template.compose).problems, ...problems];
      const bindIp = this.bindIp(server, row.bind as AppBind);
      if (bindIp === null) all.push('Tailscale-IP unbekannt');
      if (all.length > 0) throw new HttpError(400, 'invalid_input', undefined, hint(all));
      const conflicts = this.portConflicts(row.serverId, resolved.ports, row.appId);
      if (conflicts.length > 0) throw new HttpError(409, 'conflict', undefined, hint(conflicts));
      const compose = renderCompose(template.compose, row.appId);
      const { keys, portKeys } = templateKeys(template.meta);
      const unsafe = checkCompose(compose, { keys, portKeys, appId: row.appId });
      if (unsafe.length > 0) throw new HttpError(400, 'invalid_input', undefined, hint(unsafe));
      if (bindIp === null) throw new HttpError(400, 'invalid_input');
      const env = renderEnv(
        template.meta,
        { appId: row.appId, appDir: appDir(row.appId), bindIp, tz: timeZone() },
        resolved,
      );
      files = { compose, env };
      next = { resolved, version: template.meta.version };
    }
    this.setStatus(row.id, 'updating', null);
    this.audit('app.updated', row.id, {
      appId: row.appId,
      name: row.name,
      from: row.version,
      to: next?.version ?? row.version,
    });
    const dir = appDir(row.appId);
    const secrets = [...Object.values(prevSecrets), ...Object.values(next?.resolved.secrets ?? {})];
    this.run(row.id, async () => {
      const hub = this.ctx.hub;
      let what = 'Dateien schreiben';
      try {
        if (files && next) {
          await hub.call(
            row.serverId,
            'compose.write',
            { dir, files: { 'compose.yml': files.compose, '.env': files.env } },
            { timeoutMs: WRITE_TIMEOUT_MS },
          );
          const ports: StoredPort[] = next.resolved.ports.map((x) => ({ ...x }));
          this.ctx.db
            .update(apps)
            .set({
              version: next.version,
              paramsJson: JSON.stringify(next.resolved.values),
              secretsEnc:
                Object.keys(next.resolved.secrets).length === 0
                  ? null
                  : this.ctx.box.encrypt(JSON.stringify(next.resolved.secrets), SECRETS_AAD),
              portsJson: JSON.stringify(ports),
              updatedAt: this.ctx.now(),
            })
            .where(eq(apps.id, row.id))
            .run();
          this.syncPorts(row.serverId, row.appId, row.bind, ports);
        }
        what = 'Images laden';
        await hub.call(row.serverId, 'compose.pull', { dir }, { timeoutMs: PULL_TIMEOUT_MS });
        what = 'Container starten';
        await hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setStatus(row.id, 'running', null);
      } catch (err) {
        this.fail(row.id, 'app.update_failed', rpcReason(err, what, secrets));
      }
    });
    return this.get(row.id);
  }

  remove(id: string, confirmName: string, deleteData: boolean): void {
    const row = this.requireRow(id);
    if (confirmName !== row.appId) throw new HttpError(400, 'confirm_mismatch');
    if (this.busy.has(row.id) || row.status === 'removing') throw new HttpError(409, 'busy');
    if (!this.ctx.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    this.setStatus(row.id, 'removing', null);
    const secrets = Object.values(this.secretsOf(row));
    this.run(row.id, async () => {
      try {
        await this.ctx.hub.call(
          row.serverId,
          'app.remove',
          { appId: row.appId, deleteData },
          { timeoutMs: REMOVE_TIMEOUT_MS },
        );
        this.ctx.db.delete(apps).where(eq(apps.id, row.id)).run();
        this.ctx.ports.releaseGame(row.serverId, portOwner(row.appId));
        this.audit('app.removed', row.id, {
          appId: row.appId,
          name: row.name,
          serverId: row.serverId,
          deleteData,
        });
      } catch (err) {
        this.fail(row.id, 'app.remove_failed', rpcReason(err, 'Entfernen', secrets));
      }
    });
  }

  // ---- helpers -----------------------------------------------------------------------

  private run(id: string, fn: () => Promise<void>): void {
    this.busy.add(id);
    const p = fn()
      .catch((err: unknown) => {
        this.ctx.log.error(
          { appId: id, err: err instanceof Error ? err.name : 'error' },
          'app job failed',
        );
      })
      .finally(() => {
        this.busy.delete(id);
        this.tracked.delete(p);
      });
    this.tracked.add(p);
  }

  private setStatus(id: string, status: AppStatus, lastError: string | null): void {
    this.ctx.db
      .update(apps)
      .set({
        status,
        lastError: lastError === null ? null : lastError.slice(0, 300),
        updatedAt: this.ctx.now(),
      })
      .where(eq(apps.id, id))
      .run();
  }

  private fail(id: string, action: string, reason: string): void {
    const row = this.row(id);
    if (!row) return;
    this.setStatus(id, 'error', reason);
    writeAudit(this.ctx.db, this.ctx.now(), {
      actor: 'system',
      action,
      target: id,
      details: { appId: row.appId, reason: reason.slice(0, 300) },
    });
    this.ctx.log.info({ id, action }, 'app action failed');
  }

  private audit(action: string, target: string, details?: Record<string, unknown>): void {
    writeAudit(this.ctx.db, this.ctx.now(), {
      actor: 'admin',
      action,
      target,
      ...(details ? { details } : {}),
    });
  }

  idle(): Promise<void> {
    return Promise.all([...this.tracked]).then(() => undefined);
  }

  /** Running jobs finish on their own (idle); no timers to stop. */
  stop(): void {
    this.busy.clear();
  }
}

/** Database id of an installed app (installedAppIdSchema: 16 URL-safe chars). */
const randomId = (): string => randomToken(12);
