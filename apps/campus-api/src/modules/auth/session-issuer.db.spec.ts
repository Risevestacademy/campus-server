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

function sessionIdOf(token: string): unknown {
  const payload = token.split('.')[1] ?? '';
  return (
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sid?: unknown;
    }
  ).sid;
}
