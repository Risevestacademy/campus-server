import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import {
  CohortMembersService,
  type AccessGrant,
} from '../cohorts/cohort-members.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { refreshTokens } from './schema.js';
import type { Invite } from '../invites/schema.js';
import { users as usersTable, type User } from '../users/schema.js';
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
   *
   * `user` has to be the row the grant was decided against, read before the
   * decision. Its session epoch is what the mint is held to: if the account's
   * sessions have been revoked since — which is what removing a member will
   * do — the row has moved on and nothing is minted. The account is read again
   * below for its current details, but never for its epoch: a fresh read
   * taken after a revoke would agree with the row, and wave through a grant
   * that the revoke had just made untrue.
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
    const current = await this.users.findById(user.id);
    if (!current) {
      throw new SessionUnauthorizedError('Account is not usable');
    }
    // The current row, on the epoch the grant was decided at.
    const account: User = { ...current, sessionEpoch: user.sessionEpoch };

    // Checked and minted in one transaction, so a revoke cannot land between
    // the grant being decided and the family being inserted below. Without
    // it the revoke would sweep the families that existed, miss the one
    // minted a moment later, and leave a working refresh token behind.
    const mint = async (tx: Tx) => {
      await this.assertEpochCurrent(tx, account);
      return this.mintSession(account, endsAt, now, familyId, tx);
    };
    return tx ? mint(tx) : this.db.transaction(mint);
  }

  /**
   * Holds the account's row against a revoke for the rest of the
   * transaction, and refuses if one has already landed since `account` was
   * read — which has to be before whatever decided it may have a session.
   *
   * A shared lock is enough: sign-ins and refreshes do not block one
   * another, only revokeAllSessions, whose UPDATE of the same row waits for
   * this transaction and then revokes whatever it minted.
   *
   * Always taken before any refresh-token lock. revokeAllSessions takes the
   * two in the same order — the account, then its tokens — so neither can
   * end up holding what the other is waiting for.
   */
  private async assertEpochCurrent(tx: Tx, account: User): Promise<void> {
    const [row] = await tx
      .select({ sessionEpoch: usersTable.sessionEpoch })
      .from(usersTable)
      .where(eq(usersTable.id, account.id))
      .for('share');
    if (!row || row.sessionEpoch !== account.sessionEpoch) {
      throw new SessionUnauthorizedError('Session has been revoked');
    }
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
        epoch: account.sessionEpoch,
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
        epoch: user.sessionEpoch,
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

  /**
   * Ends every session an account holds, now. For whatever takes access
   * away without warning — a suspension, a removal from a cohort, a visit
   * cut short — so that it reaches as far as the next request rather than
   * the next sign-in.
   *
   * Two things, because a session has two halves. Bumping the epoch kills
   * the access tokens already out: SessionGuard and world compare the one a
   * token was signed with against the row and refuse a mismatch. Revoking
   * the refresh families stops any of them being swapped for a new token,
   * which would carry the new epoch and walk straight back in.
   *
   * Give it the transaction of the change that takes the access away, so the
   * two commit together: a removal that left sessions alive, or sessions
   * ended for a removal that rolled back, would both be wrong.
   *
   * Not for an ending the person chose. Signing out revokes one family and
   * leaves their other devices alone, and declining an invite ends a flow,
   * not somebody's access.
   *
   * Returns the new epoch, or null when there is no such account.
   */
  async revokeAllSessions(
    userId: string,
    now: Date = new Date(),
    tx?: Tx,
  ): Promise<number | null> {
    if (!tx) {
      return this.db.transaction((tx) =>
        this.revokeAllSessions(userId, now, tx),
      );
    }

    const [bumped] = await tx
      .update(usersTable)
      .set({ sessionEpoch: sql`${usersTable.sessionEpoch} + 1` })
      .where(eq(usersTable.id, userId))
      .returning({ sessionEpoch: usersTable.sessionEpoch });
    if (!bumped) {
      return null;
    }

    // The UPDATE above is what a sign-in or refresh in flight is waited out
    // on: each holds a shared lock on this row until it commits (see
    // assertEpochCurrent). Then the same two steps as revokeFamily, for the
    // same reason: the UPDATE of the tokens reads afresh once the lock is
    // held, so it revokes the row that sign-in or refresh minted too.
    await tx
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .for('update');
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      );

    return bumped.sessionEpoch;
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
        // First, before the family lock, and safe to throw from: nothing has
        // been written yet. A revoke since the account was read above is
        // refused here; one arriving later waits for this transaction.
        await this.assertEpochCurrent(tx, user);

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
