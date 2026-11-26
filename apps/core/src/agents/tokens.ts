import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Hello } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { agentTokens, auditLog, enrollTokens, servers, type ServerRow } from '../db/schema.js';

/** Enrollment tokens are valid 15 minutes and only once (SPEC 5.3). */
export const ENROLL_TTL_MS = 15 * 60_000;

/** Domain-separated hashes, so a token of one kind never matches another table. */
export const agentTokenHash = (t: string): string => sha256Hex(`agent:${t}`);
export const enrollTokenHash = (t: string): string => sha256Hex(`enroll:${t}`);

export type HelloAuth =
  | { kind: 'agent'; server: ServerRow }
  /** `reenrolled`: the enrollment took over an existing server whose agent was revoked. */
  | { kind: 'enrolled'; server: ServerRow; agentToken: string; reenrolled: boolean }
  | { kind: 'reject'; code: 'bad_token' | 'revoked' | 'name_taken' };

export class NameTakenError extends Error {
  constructor() {
    super('name_taken');
  }
}

/**
 * Enrollment and agent tokens. Only SHA-256 hashes are stored (docs/SECURITY.md).
 * Plain tokens exist only in the enroll response and the `enrolled` message.
 */
export class AgentTokens {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /**
   * A server whose agent was revoked: it has agent tokens, but none is active.
   * Such a name can be enrolled again and the enrollment takes over the row.
   */
  private static isRevoked(tx: Pick<Db, 'select'>, serverId: string): boolean {
    const tokens = tx
      .select({ revokedAt: agentTokens.revokedAt })
      .from(agentTokens)
      .where(eq(agentTokens.serverId, serverId))
      .all();
    return tokens.length > 0 && tokens.every((t) => t.revokedAt !== null);
  }

  /**
   * Creates a one-time enrollment token for a server name. Older unused tokens for
   * the same name stop working. Throws NameTakenError if a server with this name
   * exists and its agent is not revoked (a revoked server is taken over, see
   * authenticate).
   */
  createEnrollment(
    name: string,
    location: string,
  ): { id: string; token: string; expiresAt: number } {
    const now = this.now();
    const id = randomToken(16);
    const token = randomToken(32);
    const expiresAt = now + ENROLL_TTL_MS;
    this.db.transaction((tx) => {
      const existing = tx
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.name, name))
        .get();
      if (existing && !AgentTokens.isRevoked(tx, existing.id)) {
        throw new NameTakenError();
      }
      tx.update(enrollTokens)
        .set({ usedAt: now })
        .where(and(eq(enrollTokens.name, name), isNull(enrollTokens.usedAt)))
        .run();
      tx.insert(enrollTokens)
        .values({
          id,
          name,
          location,
          tokenHash: enrollTokenHash(token),
          createdAt: now,
          expiresAt,
        })
        .run();
    });
    return { id, token, expiresAt };
  }

  /** State of an enrollment token (onboarding status); never the token. */
  enrollment(
    id: string,
  ): { usedAt: number | null; expiresAt: number; serverId: string | null } | undefined {
    return this.db
      .select({
        usedAt: enrollTokens.usedAt,
        expiresAt: enrollTokens.expiresAt,
        serverId: enrollTokens.serverId,
      })
      .from(enrollTokens)
      .where(eq(enrollTokens.id, id))
      .get();
  }

  /** Invalidates an unused enrollment token (onboarding cancelled). */
  cancelEnrollment(id: string): void {
    this.db
      .update(enrollTokens)
      .set({ usedAt: this.now() })
      .where(and(eq(enrollTokens.id, id), isNull(enrollTokens.usedAt)))
      .run();
  }

  /** True if `name` belongs to a server whose agent is not revoked (createEnrollment would throw). */
  nameTaken(name: string): boolean {
    const existing = this.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.name, name))
      .get();
    return existing !== undefined && !AgentTokens.isRevoked(this.db, existing.id);
  }

  /**
   * Checks the token of a `hello`. An agent token resolves to its server. A
   * valid enrollment token is consumed (also if the name is taken by now),
   * creates the server and a new agent token, all in one transaction.
   *
   * Re-enrollment (decision 2026-11-26): if the name belongs to a server whose
   * agent tokens are all revoked, that row is taken over (same id, so history,
   * checks, games and metrics stay). The old tokens stay revoked; only the new
   * token is valid. Audit `server.reenrolled`. A name of a non-revoked server is
   * still `name_taken`.
   */
  authenticate(hello: Hello): HelloAuth {
    const now = this.now();
    const agentRow = this.db
      .select({ token: agentTokens, server: servers })
      .from(agentTokens)
      .innerJoin(servers, eq(servers.id, agentTokens.serverId))
      .where(eq(agentTokens.tokenHash, agentTokenHash(hello.token)))
      .get();
    if (agentRow) {
      if (agentRow.token.revokedAt !== null) return { kind: 'reject', code: 'revoked' };
      return { kind: 'agent', server: agentRow.server };
    }

    return this.db.transaction((tx): HelloAuth => {
      const consumed = tx
        .update(enrollTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(enrollTokens.tokenHash, enrollTokenHash(hello.token)),
            isNull(enrollTokens.usedAt),
            gt(enrollTokens.expiresAt, now),
          ),
        )
        .returning()
        .get();
      if (!consumed) return { kind: 'reject', code: 'bad_token' };
      const existing = tx.select().from(servers).where(eq(servers.name, consumed.name)).get();
      if (existing) {
        if (!AgentTokens.isRevoked(tx, existing.id)) return { kind: 'reject', code: 'name_taken' };
        const set = {
          arch: hello.arch,
          os: hello.os,
          agentVersion: hello.version,
          capabilitiesJson: JSON.stringify(hello.capabilities),
          // A new location in the enrollment wins; an empty one keeps the old.
          ...(consumed.location !== '' ? { location: consumed.location } : {}),
          lastSeen: now,
          // A new machine under the old name must not inherit the web console.
          allowTerminal: false,
        };
        tx.update(servers).set(set).where(eq(servers.id, existing.id)).run();
        const agentToken = randomToken(32);
        tx.insert(agentTokens)
          .values({
            id: randomToken(16),
            serverId: existing.id,
            tokenHash: agentTokenHash(agentToken),
            createdAt: now,
          })
          .run();
        tx.update(enrollTokens)
          .set({ serverId: existing.id })
          .where(eq(enrollTokens.id, consumed.id))
          .run();
        tx.insert(auditLog)
          .values({
            ts: now,
            actor: 'system',
            action: 'server.reenrolled',
            target: existing.id,
            detailsJson: JSON.stringify({ name: existing.name }),
          })
          .run();
        return {
          kind: 'enrolled',
          server: { ...existing, ...set },
          agentToken,
          reenrolled: true,
        };
      }
      const server: ServerRow = {
        id: randomToken(16),
        // The name comes from the enrollment, not from the hello.
        name: consumed.name,
        location: consumed.location,
        arch: hello.arch,
        os: hello.os,
        tailscaleIp: null,
        publicIp: null,
        agentVersion: hello.version,
        capabilitiesJson: JSON.stringify(hello.capabilities),
        thresholdsJson: '{}',
        allowTerminal: false,
        createdAt: now,
        lastSeen: now,
        network: null,
      };
      tx.insert(servers).values(server).run();
      const agentToken = randomToken(32);
      tx.insert(agentTokens)
        .values({
          id: randomToken(16),
          serverId: server.id,
          tokenHash: agentTokenHash(agentToken),
          createdAt: now,
        })
        .run();
      tx.update(enrollTokens)
        .set({ serverId: server.id })
        .where(eq(enrollTokens.id, consumed.id))
        .run();
      return { kind: 'enrolled', server, agentToken, reenrolled: false };
    });
  }

  /** Revokes every active agent token of a server. Returns the number revoked. */
  revoke(serverId: string): number {
    return this.db
      .update(agentTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(agentTokens.serverId, serverId), isNull(agentTokens.revokedAt)))
      .run().changes;
  }

  hasActiveToken(serverId: string): boolean {
    return (
      this.db
        .select({ id: agentTokens.id })
        .from(agentTokens)
        .where(and(eq(agentTokens.serverId, serverId), isNull(agentTokens.revokedAt)))
        .get() !== undefined
    );
  }
}
