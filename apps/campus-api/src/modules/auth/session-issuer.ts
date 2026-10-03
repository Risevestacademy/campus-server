import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, isNotNull, lt, or } from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import {
  CohortMembersService,
  type AccessGrant,
} from '../cohorts/cohort-members.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { refreshTokens } from './schema.js';
import type { Invite } from '../invites/schema.js';
import type { User } from '../users/schema.js';
import { isAdmin, isSuspended, UsersService } from '../users/users.service.js';
import { requireGoogleAuth } from './google-auth.settings.js';
import { SessionScope, signSessionToken } from '@campus/session';

/** The transaction handle drizzle hands a `db.transaction` callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The configured lifetime, shortened when the grant behind it ends sooner.
 *
 * No floor. Rounding a remainder up to a minute hands back access past the
 * deadline, which is the whole thing this is here to prevent; a token with
 * seconds left simply sends the browser to sign-in, where the gate refuses
 * them properly. A grant already over is rejected by the caller, so the
 * remainder here is always positive.
 */
function cappedTtlMinutes(
  ttlMinutes: number,
  endsAt: Date | null,
  now: Date,
): number {
  if (endsAt === null) {
    return ttlMinutes;
  }
  return Math.min(ttlMinutes, (endsAt.getTime() - now.getTime()) / 60_000);
}

const REFRESH_GRACE_MS = 60_000;
const REFRESH_CLEANUP_USED_MS = 30 * 60_000;
const REFRESH_CLEANUP_EXPIRED_MS = 3 * 86_400_000;

interface IssuedSessionBase {
  token: string;
  expiresAt: Date;
  /** Where the browser is sent once the cookie is set. */
  redirectPath: string;
}

export type IssuedSession =
  | (IssuedSessionBase & {
      scope: typeof SessionScope.FullAccess;
      refreshToken: string;
      refreshExpiresAt: Date;
    })
  | (IssuedSessionBase & {
      scope: typeof SessionScope.Provisional;
      refreshToken?: never;
      refreshExpiresAt?: never;
    });

export type FullAccessSession = Extract<
  IssuedSession,
  { scope: typeof SessionScope.FullAccess }
>;

/**
 * Mints the session a completed Google sign-in earns, and rotates it: a
 * full-access session is a short access token plus a refresh token, one
 * family per sign-in. docs/auth-flow.md has the whole cycle.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly users: UsersService,
    private readonly members: CohortMembersService,
  ) {}

  /**
   * Someone already on the roster: nothing left to finish.
   *
   * Takes the grant that authorised them rather than looking one up, so the
   * deadline is the one the decision was made against. Reading it again here
   * would be a second clock: a guest crossing their deadline between the two
   * reads looks authorised to the first and unexpiring to the second, and
   * walks away with a full-length token for a visit that has ended.
   *
   * The token never outlives that grant. SessionGuard re-reads the user row
   * per request but not their memberships, so without this cap a visit that
   * ended at 09:00 would keep working until the token happened to lapse, up
   * to AUTH_SESSION_TTL_MINUTES later. `world` knows nothing of cohorts and
   * follows the sign-in rather than the token, so the cap reaches it the next
   * way round: once this token lapses the refresh fails, the family is
   * revoked, and world closes the socket.
   *
   * A grant that has already ended is refused outright. By the time we are
   * minting, its holder is somebody the sign-in gate would now turn away.
   */
  async issueFullAccess(
    user: User,
    grant: AccessGrant,
    now: Date = new Date(),
    familyId: string = randomUUID(),
    tx?: Tx,
  ): Promise<FullAccessSession> {
    const endsAt = grant.endsAt;
    if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
      throw new SessionUnauthorizedError('Access has already ended');
    }
    const account = await this.users.findById(user.id);
    if (!account) {
      throw new SessionUnauthorizedError('Account is not usable');
    }
    return this.mintSession(account, endsAt, now, familyId, tx);
  }

  /**
   * The minting half of issueFullAccess, split out so refreshSession can run
   * it inside an open transaction.
   *
   * Only signs a token and inserts the refresh row: no UsersService or
   * CohortMembersService call, so it needs nothing but the transaction handle
   * it is given. Those services each hold their own connection, and querying
   * one from inside an open transaction asks a single connection to serve
   * itself.
   */
  private async mintSession(
    account: User,
    endsAt: Date | null,
    now: Date,
    familyId: string,
    tx?: Tx,
  ): Promise<FullAccessSession> {
    const { token, expiresAt } = await signSessionToken(
      {
        userId: account.id,
        email: account.email,
        scope: SessionScope.FullAccess,
        // The refresh family, so world can hold a socket for as long as this
        // login is alive and being refreshed, rather than for one access
        // token's fifteen minutes.
        sessionId: familyId,
      },
      {
        secret: this.secret,
        ttlMinutes: cappedTtlMinutes(
          this.config.AUTH_SESSION_TTL_MINUTES,
          endsAt,
          now,
        ),
      },
      now,
    );

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(
      now.getTime() + this.config.AUTH_REFRESH_TTL_DAYS * 86_400_000,
    );
    const db = tx ?? this.db;
    await db.insert(refreshTokens).values({
      userId: account.id,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt,
    });

    return {
      token,
      refreshToken,
      refreshExpiresAt,
      expiresAt,
      scope: SessionScope.FullAccess,
      redirectPath: '/campus',
    };
  }

  /**
   * Someone holding an invite they have not accepted. The invite travels in
   * the token so the accept route knows which one is being answered without
   * trusting the caller to say.
   */
  async issueProvisional(user: User, invite: Invite): Promise<IssuedSession> {
    const { token, expiresAt } = await signSessionToken(
      {
        userId: user.id,
        email: user.email,
        scope: SessionScope.Provisional,
        inviteId: invite.id,
      },
      {
        secret: this.secret,
        ttlMinutes: this.config.AUTH_PROVISIONAL_TTL_MINUTES,
      },
    );

    return {
      token,
      expiresAt,
      scope: SessionScope.Provisional,
      redirectPath: '/invitation',
    };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const [stored] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)))
      .limit(1);
    if (stored) {
      await this.revokeFamily(stored.familyId, new Date());
    }
  }

  async refreshSession(
    token: string,
    now: Date = new Date(),
  ): Promise<FullAccessSession> {
    await this.cleanupRefreshTokens(now);

    // Read-only work happens outside the transaction, both because it needs
    // no lock and because UsersService/CohortMembersService hold their own
    // connection: querying them from inside an open transaction would ask one
    // connection to serve itself.
    const [stored] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)))
      .limit(1);

    if (
      !stored ||
      stored.revokedAt !== null ||
      stored.expiresAt.getTime() <= now.getTime()
    ) {
      throw new SessionUnauthorizedError('Refresh token is not usable');
    }

    const user = await this.users.findById(stored.userId);
    if (!user) {
      await this.revokeFamily(stored.familyId, now);
      throw new SessionUnauthorizedError('Refresh token is not usable');
    }
    if (isSuspended(user)) {
      await this.revokeFamily(stored.familyId, now);
      throw new SessionUnauthorizedError('Account is suspended');
    }

    const grant = isAdmin(user)
      ? { endsAt: null }
      : await this.members.resolveActiveAccess(user.id, now);
    if (!grant) {
      await this.revokeFamily(stored.familyId, now);
      throw new SessionUnauthorizedError('Access has already ended');
    }

    // One transaction for the three steps that must not interleave: claim the
    // old token, re-check the family, mint the replacement. The family is
    // locked first so that a replayed token revoking it, and this refresh
    // minting its replacement, serialise. revokeFamily takes the same lock, so
    // whichever gets it first, the other sees its work: if the revoke lands
    // first this re-read finds the family revoked and mints nothing; if this
    // lands first, the revoke waits for it to commit and then revokes the row
    // inserted here too.
    return this.db
      .transaction(async (tx) => {
        await tx
          .select({ id: refreshTokens.id })
          .from(refreshTokens)
          .where(eq(refreshTokens.familyId, stored.familyId))
          .for('update');

        // Re-read under the lock: the row may have been used or revoked during
        // the checks above, while this transaction waited for the family.
        const [locked] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, stored.id))
          .limit(1);

        if (
          !locked ||
          locked.revokedAt !== null ||
          locked.expiresAt.getTime() <= now.getTime()
        ) {
          return { kind: 'unusable' } as const;
        }

        const familyId = locked.familyId;
        if (locked.usedAt === null) {
          const [claimed] = await tx
            .update(refreshTokens)
            .set({ usedAt: now })
            .where(
              and(
                eq(refreshTokens.id, locked.id),
                isNull(refreshTokens.usedAt),
              ),
            )
            .returning({ id: refreshTokens.id });

          if (!claimed) {
            // Another request claimed it between our read and the lock.
            const [raced] = await tx
              .select({ usedAt: refreshTokens.usedAt })
              .from(refreshTokens)
              .where(eq(refreshTokens.id, locked.id))
              .limit(1);
            if (
              !raced?.usedAt ||
              raced.usedAt.getTime() + REFRESH_GRACE_MS < now.getTime()
            ) {
              await this.revokeFamily(familyId, now, tx);
              return { kind: 'reuse' } as const;
            }
          }
        } else if (locked.usedAt.getTime() + REFRESH_GRACE_MS < now.getTime()) {
          await this.revokeFamily(familyId, now, tx);
          return { kind: 'reuse' } as const;
        }

        return {
          kind: 'session',
          session: await this.mintSession(
            user,
            grant.endsAt,
            now,
            familyId,
            tx,
          ),
        } as const;
      })
      .then((outcome) => {
        // Thrown only once the transaction has committed: a throw inside it
        // would roll back the revoke made there. The revoke itself stays
        // inside, under the family lock -- after commit, a refresh of a sibling
        // token could take the lock first and mint a row it would miss.
        if (outcome.kind === 'reuse') {
          throw new SessionUnauthorizedError('Refresh token reuse detected');
        }
        if (outcome.kind === 'unusable') {
          throw new SessionUnauthorizedError('Refresh token is not usable');
        }
        return outcome.session;
      });
  }

  /**
   * Locks the family before revoking it, so a refresh holding the lock is
   * waited out and the row it minted is revoked too.
   *
   * A bare UPDATE would miss that row: it reads the family as of its own
   * start, and on waking re-checks only the rows it already found. The UPDATE
   * is a separate statement from the lock for the same reason -- it reads the
   * family afresh once the lock is held.
   */
  private async revokeFamily(
    familyId: string,
    now: Date,
    tx?: Tx,
  ): Promise<void> {
    if (!tx) {
      await this.db.transaction((tx) => this.revokeFamily(familyId, now, tx));
      return;
    }
    await tx
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId))
      .for('update');
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  private async cleanupRefreshTokens(now: Date): Promise<void> {
    await this.db
      .delete(refreshTokens)
      .where(
        or(
          and(
            isNotNull(refreshTokens.usedAt),
            lt(
              refreshTokens.usedAt,
              new Date(now.getTime() - REFRESH_CLEANUP_USED_MS),
            ),
          ),
          lt(
            refreshTokens.expiresAt,
            new Date(now.getTime() - REFRESH_CLEANUP_EXPIRED_MS),
          ),
        ),
      );
  }

  private get secret(): string {
    return requireGoogleAuth(this.config).sessionSecret;
  }
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
