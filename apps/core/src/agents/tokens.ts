import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Hello } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { agentTokens, enrollTokens, servers, type ServerRow } from '../db/schema.js';

/** Enrollment tokens are valid 15 minutes and only once (SPEC 5.3). */
export const ENROLL_TTL_MS = 15 * 60_000;

/** Domain-separated hashes, so a token of one kind never matches another table. */
export const agentTokenHash = (t: string): string => sha256Hex(`agent:${t}`);
export const enrollTokenHash = (t: string): string => sha256Hex(`enroll:${t}`);

export type HelloAuth =
  | { kind: 'agent'; server: ServerRow }
  | { kind: 'enrolled'; server: ServerRow; agentToken: string }
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
   * Creates a one-time enrollment token for a new server name. Older unused
   * tokens for the same name stop working. Throws NameTakenError if a server
   * with this name exists.
   */
  createEnrollment(name: string, location: string): { token: string; expiresAt: number } {
    const now = this.now();
    const token = randomToken(32);
    const expiresAt = now + ENROLL_TTL_MS;
    this.db.transaction((tx) => {
      if (tx.select({ id: servers.id }).from(servers).where(eq(servers.name, name)).get()) {
        throw new NameTakenError();
      }
      tx.update(enrollTokens)
        .set({ usedAt: now })
        .where(and(eq(enrollTokens.name, name), isNull(enrollTokens.usedAt)))
        .run();
      tx.insert(enrollTokens)
        .values({
          id: randomToken(16),
          name,
          location,
          tokenHash: enrollTokenHash(token),
          createdAt: now,
          expiresAt,
        })
        .run();
    });
    return { token, expiresAt };
  }

  /**
   * Checks the token of a `hello`. An agent token resolves to its server. A
   * valid enrollment token is consumed (also if the name is taken by now),
   * creates the server and a new agent token, all in one transaction.
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
      if (
        tx.select({ id: servers.id }).from(servers).where(eq(servers.name, consumed.name)).get()
      ) {
        return { kind: 'reject', code: 'name_taken' };
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
      return { kind: 'enrolled', server, agentToken };
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
