import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  gameModFileSchema,
  gameModsListDataSchema,
  MOD_MAX_BYTES,
  modFileNameSchema,
  modrinthCdnUrlSchema,
  type GameStatusData,
  type ModKind,
} from '@hz/shared';
import type { FetchLike } from '../checks/rdap.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { gameMods, type GameServerRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { modsKindOf, type GameService } from './service.js';

/** The only API host the core asks (paths are built here, never from input). */
export const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'homelab-zentrale';
const MODRINTH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODS_RPC_TIMEOUT_MS = 30_000;
/** The agent downloads up to 100 MiB from the CDN. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MODRINTH_DOWN = 'Modrinth nicht erreichbar';

const idSchema = z.string().regex(/^[A-Za-z0-9]{8}$/);
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;

const searchSchema = z.object({
  hits: z
    .array(
      z.object({
        project_id: z.string(),
        slug: z.string(),
        title: z.string(),
        description: z.string(),
        downloads: z.number(),
      }),
    )
    .max(100),
});

const projectSchema = z.object({ id: idSchema, title: z.string().min(1) });

const versionsSchema = z
  .array(
    z.object({
      id: z.string(),
      project_id: z.string(),
      date_published: z.string(),
      files: z
        .array(
          z.object({
            url: z.string(),
            filename: z.string(),
            primary: z.boolean(),
            size: z.number(),
            hashes: z.object({ sha512: z.string().optional() }),
          }),
        )
        .max(20),
    }),
  )
  .max(500);

type Version = z.infer<typeof versionsSchema>[number];
export type ModFile = Version['files'][number];

const LOADER: Record<ModKind, string> = { plugins: 'paper', mods: 'fabric' };
const PROJECT_TYPE: Record<ModKind, string> = { plugins: 'plugin', mods: 'mod' };

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The file of a Modrinth version the agent may install: the primary file (or
 * the only one), a .jar, from cdn.modrinth.com, with a sha512 and a size within
 * the limit. Null otherwise (nothing from Modrinth is trusted as is).
 */
export function pickModFile(v: Version): {
  url: string;
  fileName: string;
  sha512: string;
  sizeBytes: number;
} | null {
  const file = v.files.find((f) => f.primary) ?? (v.files.length === 1 ? v.files[0] : undefined);
  if (!file) return null;
  const sha512 = file.hashes.sha512?.toLowerCase();
  if (!sha512 || !/^[0-9a-f]{128}$/.test(sha512)) return null;
  if (!modrinthCdnUrlSchema.safeParse(file.url).success) return null;
  if (!modFileNameSchema.safeParse(file.filename).success) return null;
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MOD_MAX_BYTES) return null;
  return { url: file.url, fileName: file.filename, sha512, sizeBytes: file.size };
}

export interface GameModsView {
  kind: ModKind;
  loader: string;
  gameVersion: string | null;
  files: { fileName: string; sizeBytes: number; title: string | null; projectId: string | null }[];
  restartNeeded: boolean;
}

/**
 * Modrinth mods/plugins (SPEC 6.5) for Minecraft Java with Paper (plugins) or
 * Fabric (mods). The core searches and picks the version; the agent downloads
 * only the cdn.modrinth.com URL it was given and checks the sha512.
 */
export class GameModsService {
  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      games: GameService;
      log: FastifyBaseLogger;
      fetch?: FetchLike;
    },
  ) {}

  private target(row: GameServerRow): { kind: ModKind; loader: string; version: string | null } {
    const t = this.deps.games.templates.get(row.templateId)?.template;
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(row.settingsJson) as Record<string, unknown>;
    } catch {
      values = {};
    }
    const kind = modsKindOf(t, values);
    if (!t?.mods || kind === null) throw new HttpError(409, 'conflict');
    const v = values[t.mods.versionField];
    let version = typeof v === 'string' && VERSION_RE.test(v) ? v : null;
    if (version === null) {
      // LATEST: the version the server reported ("Paper 1.21.4").
      let st: GameStatusData | null;
      try {
        st = row.statusJson === null ? null : (JSON.parse(row.statusJson) as GameStatusData);
      } catch {
        st = null;
      }
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(st?.version ?? '');
      version = m?.[1] ?? null;
    }
    return { kind, loader: LOADER[kind], version };
  }

  private async getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${MODRINTH_API}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(MODRINTH_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(404, 'not_found');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    }
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (text === null) throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    }
  }

  private meta(gameId: string): Map<string, { title: string; projectId: string }> {
    return new Map(
      this.deps.db
        .select()
        .from(gameMods)
        .where(eq(gameMods.gameId, gameId))
        .all()
        .map((m) => [m.fileName, { title: m.title, projectId: m.projectId }]),
    );
  }

  async list(gameId: string): Promise<GameModsView> {
    const row = this.requireRow(gameId);
    const tgt = this.target(row);
    const data = await this.deps.games.callAgent(
      row,
      'game.mods.list',
      {
        gameId: row.name,
        kind: tgt.kind,
      },
      MODS_RPC_TIMEOUT_MS,
    );
    const parsed = gameModsListDataSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    const meta = this.meta(gameId);
    // Metadata of files that are gone (removed by hand) is dropped.
    const present = new Set(parsed.data.files.map((f) => f.fileName));
    for (const name of meta.keys()) {
      if (!present.has(name)) {
        this.deps.db
          .delete(gameMods)
          .where(and(eq(gameMods.gameId, gameId), eq(gameMods.fileName, name)))
          .run();
      }
    }
    return {
      kind: tgt.kind,
      loader: tgt.loader,
      gameVersion: tgt.version,
      files: parsed.data.files.map((f) => ({
        fileName: f.fileName,
        sizeBytes: f.sizeBytes,
        title: meta.get(f.fileName)?.title ?? null,
        projectId: meta.get(f.fileName)?.projectId ?? null,
      })),
      restartNeeded: this.deps.games.row(gameId)?.modsRestartNeeded ?? false,
    };
  }

  async search(gameId: string, q: string) {
    const row = this.requireRow(gameId);
    const tgt = this.target(row);
    const facets: string[][] = [
      [`project_type:${PROJECT_TYPE[tgt.kind]}`],
      [`categories:${tgt.loader}`],
    ];
    if (tgt.version) facets.push([`versions:${tgt.version}`]);
    const params = new URLSearchParams({
      query: q,
      limit: '20',
      index: 'relevance',
      facets: JSON.stringify(facets),
    });
    const parsed = searchSchema.safeParse(await this.getJson(`/search?${params.toString()}`));
    if (!parsed.success) throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    const installed = new Set([...this.meta(gameId).values()].map((m) => m.projectId));
    return {
      hits: parsed.data.hits
        .filter((h) => idSchema.safeParse(h.project_id).success)
        .slice(0, 20)
        .map((h) => ({
          projectId: h.project_id,
          slug: cut(h.slug, 100),
          title: cut(h.title, 200),
          description: cut(h.description, 400),
          downloads: Math.max(0, Math.floor(h.downloads)),
          installed: installed.has(h.project_id),
        })),
    };
  }

  /** Newest version for loader + game version, then game.mods.install on the agent. */
  async install(gameId: string, projectId: string): Promise<GameModsView> {
    const row = this.requireRow(gameId);
    const tgt = this.target(row);
    if (!idSchema.safeParse(projectId).success) throw new HttpError(400, 'invalid_input');
    const project = projectSchema.safeParse(
      await this.getJson(`/project/${encodeURIComponent(projectId)}`),
    );
    if (!project.success || project.data.id !== projectId) {
      throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    }
    const params = new URLSearchParams({ loaders: JSON.stringify([tgt.loader]) });
    if (tgt.version) params.set('game_versions', JSON.stringify([tgt.version]));
    const versions = versionsSchema.safeParse(
      await this.getJson(`/project/${encodeURIComponent(projectId)}/version?${params.toString()}`),
    );
    if (!versions.success) throw new HttpError(502, 'internal', undefined, MODRINTH_DOWN);
    const newest = versions.data
      .filter((v) => v.project_id === projectId)
      .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))[0];
    if (!newest) throw new HttpError(404, 'not_found', undefined, 'Keine passende Version');
    const file = pickModFile(newest);
    if (!file) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        'Datei nicht von Modrinth oder ohne Prüfsumme',
      );
    }
    const data = await this.deps.games.callAgent(
      row,
      'game.mods.install',
      { gameId: row.name, kind: tgt.kind, ...file },
      INSTALL_TIMEOUT_MS,
    );
    const done = gameModFileSchema.safeParse(data);
    const fileName = done.success ? done.data.fileName : file.fileName;
    const title = cut(project.data.title.replace(/[\p{Cc}\p{Cf}]/gu, ''), 200);
    const now = this.deps.now();
    this.deps.db
      .insert(gameMods)
      .values({ gameId, fileName, projectId, title, installedAt: now })
      .onConflictDoUpdate({
        target: [gameMods.gameId, gameMods.fileName],
        set: { projectId, title, installedAt: now },
      })
      .run();
    this.deps.games.setModsRestartNeeded(gameId, true);
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'game.mod_installed',
      target: gameId,
      details: { name: row.name, projectId, fileName, sha512: file.sha512.slice(0, 16) },
    });
    return this.list(gameId);
  }

  async remove(gameId: string, fileName: string): Promise<GameModsView> {
    const row = this.requireRow(gameId);
    const tgt = this.target(row);
    if (!modFileNameSchema.safeParse(fileName).success) throw new HttpError(400, 'invalid_input');
    await this.deps.games.callAgent(
      row,
      'game.mods.remove',
      { gameId: row.name, kind: tgt.kind, fileName },
      MODS_RPC_TIMEOUT_MS,
    );
    this.deps.db
      .delete(gameMods)
      .where(and(eq(gameMods.gameId, gameId), eq(gameMods.fileName, fileName)))
      .run();
    this.deps.games.setModsRestartNeeded(gameId, true);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'game.mod_removed',
      target: gameId,
      details: { name: row.name, fileName },
    });
    return this.list(gameId);
  }

  private requireRow(gameId: string): GameServerRow {
    const row = this.deps.games.row(gameId);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }
}

/** Response text up to `max` bytes, null when larger. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
