import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import * as schema from '../../infra/database/schema/index.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import { UsersService } from '../users/users.service.js';
import { SessionUnauthorizedError } from './auth.exceptions.js';
import { refreshTokens } from './schema.js';
import { SessionIssuer } from './session-issuer.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), { schema });
const now = new Date('2026-09-29T12:00:00.000Z');
const config = {
  FF_GOOGLE_AUTH_ENABLED: true,
  AUTH_SESSION_TTL_MINUTES: 15,
  AUTH_PROVISIONAL_TTL_MINUTES: 30,
  AUTH_REFRESH_TTL_DAYS: 30,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  AUTH_STATE_SECRET: 'a'.repeat(48),
  AUTH_SESSION_SECRET: 'b'.repeat(48),
} as never;

let issuer: SessionIssuer;
let user: typeof users.$inferSelect;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  issuer = new SessionIssuer(
    config,
    db as never,
    new UsersService(db as never),
    new CohortMembersService(db as never),
  );
});

beforeEach(async () => {
  await db.execute(sql`truncate refresh_tokens, users cascade`);
  [user] = await db
    .insert(users)
    .values({
      email: 'refresh@campus.local',
      systemRole: SystemRole.Admin,
    })
    .returning();
});

describe('SessionIssuer refresh persistence', () => {
  it('marks a token used and rotates another token in the same family', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    const second = await issuer.refreshSession(first.refreshToken, now);

    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows[0].familyId).toBe(rows[1].familyId);
    expect(rows[0].usedAt).toEqual(now);
    expect(rows[1].usedAt).toBeNull();
    expect(second.refreshExpiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  /**
   * world holds a socket for as long as the login behind it lives, so every
   * access token has to name that login — the first one and each rotation.
   */
  it('names the refresh family in every access token it issues', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    if (first.scope !== 'full_access')
      throw new Error('expected a full session');
    const second = await issuer.refreshSession(first.refreshToken, now);

    const [row] = await db.select().from(refreshTokens).limit(1);
    // Decoded rather than verified: `now` is pinned, so by the real clock
    // these tokens have already expired.
    expect(sessionIdOf(first.token)).toBe(row.familyId);
    expect(sessionIdOf(second.token)).toBe(row.familyId);
  });

  it('accepts the old token during the grace window', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    await issuer.refreshSession(first.refreshToken, now);

    await expect(
      issuer.refreshSession(
        first.refreshToken,
        new Date(now.getTime() + 30_000),
      ),
    ).resolves.toMatchObject({ scope: 'full_access' });

    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });

  it('revokes the entire family after grace-window reuse', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    await issuer.refreshSession(first.refreshToken, now);

    await expect(
      issuer.refreshSession(
        first.refreshToken,
        new Date(now.getTime() + 61_000),
      ),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);

    const rows = await db.select().from(refreshTokens);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('revokes the family when the account is suspended', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, user.id));

    await expect(
      issuer.refreshSession(first.refreshToken, now),
    ).rejects.toThrow('Account is suspended');

    const [row] = await db.select().from(refreshTokens);
    expect(row.revokedAt).not.toBeNull();
  });

  it('cleans used and long-expired rows during refresh', async () => {
    await db.insert(refreshTokens).values([
      {
        userId: user.id,
        familyId: crypto.randomUUID(),
        tokenHash: 'used-token'.padEnd(64, '0'),
        expiresAt: new Date(now.getTime() + 86_400_000),
        usedAt: new Date(now.getTime() - 31 * 60_000),
      },
      {
        userId: user.id,
        familyId: crypto.randomUUID(),
        tokenHash: 'expired-token'.padEnd(64, '0'),
        expiresAt: new Date(now.getTime() - 4 * 86_400_000),
      },
    ]);
    const active = await issuer.issueFullAccess(user, { endsAt: null }, now);

    await issuer.refreshSession(active.refreshToken, now);

    const rows = await db.select().from(refreshTokens);
    expect(rows.some((row) => row.tokenHash.startsWith('used-token'))).toBe(
      false,
    );
    expect(rows.some((row) => row.tokenHash.startsWith('expired-token'))).toBe(
      false,
    );
  });

  /**
   * The race the transaction exists to close: the family is revoked between
   * this refresh reading the token and minting its replacement, so the token it
   * hands back would be the one live row left in a family that reuse detection
   * had just killed.
   *
   * The revoke is timed to land in exactly that window. refreshSession reads
   * the token, then resolves the account, then opens the transaction -- and the
   * wrapped findById revokes the family in the gap. Revoking from *inside* the
   * transaction is not an option here: PGlite serves one connection, so a query
   * on db while a transaction is open asks it to serve itself and deadlocks.
   * This is the faithful single-connection equivalent, and it fails against an
   * implementation that checks the family before claiming and then inserts
   * without re-reading under the lock.
   */
  it('never mints into a family revoked between reading the token and minting', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    const [tokenRow] = await db.select().from(refreshTokens).limit(1);

    const realUsers = new UsersService(db as never);
    const revokingUsers = {
      findById: async (id: string) => {
        const account = await realUsers.findById(id);
        // The replayed token wins the race here.
        await db
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(eq(refreshTokens.familyId, tokenRow.familyId));
        return account;
      },
    };
    const racing = new SessionIssuer(
      config,
      db as never,
      revokingUsers as never,
      new CohortMembersService(db as never),
    );

    await expect(
      racing.refreshSession(first.refreshToken, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);

    // Nothing minted: the one row in the family is the revoked original.
    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe('SessionIssuer.revokeAllSessions', () => {
  // Decoded rather than verified, as above: `now` is pinned.
  const epochOf = async (token: string) => claimsOf(token).epoch;
  const rowEpoch = async () => {
    const [row] = await db
      .select({ sessionEpoch: users.sessionEpoch })
      .from(users)
      .where(eq(users.id, user.id));
    return row.sessionEpoch;
  };

  /** The row as it is now: what a sign-in starts from. */
  const fresh = async () => {
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    return row;
  };

  it('signs a session with the epoch of the row the grant was decided on', async () => {
    const first = await issuer.issueFullAccess(user, { endsAt: null }, now);
    expect(await epochOf(first.token)).toBe(0);

    await db
      .update(users)
      .set({ sessionEpoch: 7 })
      .where(eq(users.id, user.id));
    const second = await issuer.issueFullAccess(
      await fresh(),
      { endsAt: null },
      now,
    );

    expect(await epochOf(second.token)).toBe(7);
  });

  /**
   * The interleaving that matters most: a sign-in reads the account and
   * decides it may come in; the member is then removed, which revokes their
   * sessions; and only then is the session minted.
   *
   * The issuer reads the account again as it mints, and that read agrees
   * with the row. If the mint were held to that read, it would pass, and a
   * removed member would walk away with a full session that nothing checks
   * again until it expires. It is held to the row the decision was made on.
   */
  it('mints nothing when the account was revoked after the grant was decided', async () => {
    const decidedOn = await fresh();
    const grant = { endsAt: null };

    await issuer.revokeAllSessions(user.id, now);

    await expect(
      issuer.issueFullAccess(decidedOn, grant, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);
    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  it('bumps the epoch and revokes every family the account holds', async () => {
    const laptop = await issuer.issueFullAccess(user, { endsAt: null }, now);
    const phone = await issuer.issueFullAccess(user, { endsAt: null }, now);

    await expect(issuer.revokeAllSessions(user.id, now)).resolves.toBe(1);

    expect(await rowEpoch()).toBe(1);
    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    // Neither device can swap its way back in.
    for (const session of [laptop, phone]) {
      await expect(
        issuer.refreshSession(session.refreshToken, now),
      ).rejects.toBeInstanceOf(SessionUnauthorizedError);
    }
  });

  it('leaves the tokens already out carrying the old epoch', async () => {
    const before = await issuer.issueFullAccess(user, { endsAt: null }, now);

    await issuer.revokeAllSessions(user.id, now);

    // Which is what the guard refuses: 0 on the token, 1 on the row.
    expect(await epochOf(before.token)).toBe(0);
    expect(await rowEpoch()).toBe(1);
  });

  it('lets the account sign in again afterwards, on the new epoch', async () => {
    await issuer.revokeAllSessions(user.id, now);

    // A new sign-in reads the account afresh, and is decided on that.
    const again = await issuer.issueFullAccess(
      await fresh(),
      { endsAt: null },
      now,
    );

    expect(await epochOf(again.token)).toBe(1);
    await expect(
      issuer.refreshSession(again.refreshToken, now),
    ).resolves.toMatchObject({ scope: 'full_access' });
  });

  it('counts up each time, and never touches another account', async () => {
    const [other] = await db
      .insert(users)
      .values({ email: 'other@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const theirs = await issuer.issueFullAccess(other, { endsAt: null }, now);

    await issuer.revokeAllSessions(user.id, now);
    await expect(issuer.revokeAllSessions(user.id, now)).resolves.toBe(2);

    const [row] = await db
      .select({ sessionEpoch: users.sessionEpoch })
      .from(users)
      .where(eq(users.id, other.id));
    expect(row.sessionEpoch).toBe(0);
    await expect(
      issuer.refreshSession(theirs.refreshToken, now),
    ).resolves.toMatchObject({ scope: 'full_access' });
  });

  it('answers null for an account that does not exist', async () => {
    await expect(
      issuer.revokeAllSessions('99999999-9999-4999-8999-999999999999', now),
    ).resolves.toBeNull();
  });

  // Whatever takes the access away passes its own transaction, so the two
  // commit together — or neither does.
  it('rolls back with the transaction it was given', async () => {
    const session = await issuer.issueFullAccess(user, { endsAt: null }, now);

    await expect(
      db.transaction(async (tx) => {
        await issuer.revokeAllSessions(user.id, now, tx as never);
        throw new Error('the removal failed');
      }),
    ).rejects.toThrow('the removal failed');

    expect(await rowEpoch()).toBe(0);
    await expect(
      issuer.refreshSession(session.refreshToken, now),
    ).resolves.toMatchObject({ scope: 'full_access' });
  });

  /**
   * The gap a sign-in leaves: it reads the account, then mints. A revoke
   * landing between the two has already swept the account's families, so the
   * family minted a moment later would be the one it missed — an access
   * token on the old epoch, refused, beside a refresh token that still works.
   *
   * Timed the way the family race above is: the wrapped findById revokes in
   * the gap, which is the single-connection equivalent of the two
   * overlapping.
   */
  const revokingInTheGap = () => {
    const realUsers = new UsersService(db as never);
    return new SessionIssuer(
      config,
      db as never,
      {
        findById: async (id: string) => {
          const account = await realUsers.findById(id);
          await issuer.revokeAllSessions(id, now);
          return account;
        },
      } as never,
      new CohortMembersService(db as never),
    );
  };

  it('mints nothing for a sign-in the revoke overtook', async () => {
    await expect(
      revokingInTheGap().issueFullAccess(user, { endsAt: null }, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);

    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  it('mints nothing for a refresh the revoke overtook', async () => {
    const session = await issuer.issueFullAccess(user, { endsAt: null }, now);

    await expect(
      revokingInTheGap().refreshSession(session.refreshToken, now),
    ).rejects.toBeInstanceOf(SessionUnauthorizedError);

    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('carries the epoch onto a provisional session too', async () => {
    await db
      .update(users)
      .set({ sessionEpoch: 3 })
      .where(eq(users.id, user.id));
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id));

    const session = await issuer.issueProvisional(account, {
      id: '44444444-4444-4444-8444-444444444444',
    } as never);

    expect(await epochOf(session.token)).toBe(3);
  });
});

function claimsOf(token: string): { sid?: unknown; epoch?: unknown } {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sid?: unknown;
    epoch?: unknown;
  };
}

function sessionIdOf(token: string): unknown {
  return claimsOf(token).sid;
}
