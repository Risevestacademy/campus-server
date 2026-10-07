import postgres from 'postgres';

import type { Env } from './env.js';

/**
 * What the socket layer needs to know about the person behind a token, and
 * nothing else. An interface so the gateway can be tested without a database
 * and so the lookup can move behind Redis later without touching callers.
 */
export interface AccountLookup {
  /** Null when no such account exists — a token outliving its user. */
  find(userId: string): Promise<Account | null>;
  /**
   * Which of these sessions (refresh-token families) are still live: not
   * revoked, not expired, and refreshed at or after `refreshedSince`. One
   * query for every open socket, however many there are.
   */
  liveSessions(
    sessionIds: readonly string[],
    refreshedSince: Date,
    now: Date,
  ): Promise<Set<string>>;
  liveMembership(userId: string, cohortId: string, now: Date): Promise<boolean>;
  close(): Promise<void>;
}

export interface Account {
  id: string;
  suspended: boolean;
  /**
   * USERS.session_epoch: how many times this account's sessions have been
   * ended on purpose. A token signed with any other value is one of those
   * ended sessions.
   */
  sessionEpoch: number;
  /** Admins bypass cohort gating, as they do at campus-api's sign-in gate. */
  admin: boolean;
}

/**
 * Whether USERS.system_role is one that does what admins do. campus-api has
 * two, `admin` and `super_admin`, and asks the same question through its own
 * hasAdminPowers; comparing against `admin` alone would shut every super
 * admin out of a cohort they are not a member of.
 */
export function hasAdminPowers(systemRole: string): boolean {
  return systemRole === 'admin' || systemRole === 'super_admin';
}

/**
 * Exported so a test can run the very same statement against a real
 * PostgreSQL engine. The columns belong to campus-api's migration, and a
 * rename there would otherwise only surface as every socket refusing a
 * perfectly good session.
 */
export const ACCOUNT_QUERY =
  'select id, status, system_role, session_epoch from users where id = $1 limit 1';

/**
 * A login is live while its refresh family holds a token that is neither
 * revoked nor expired and was minted recently. Rotation mints a new row on
 * every refresh, and every refresh re-checks suspension and access first, so
 * "minted recently" is campus-api vouching for the session again. Signing out
 * revokes the family outright.
 *
 * $1 uuid[] of families, $2 refreshed-since, $3 now. Same reason to export it
 * as ACCOUNT_QUERY: refresh_tokens belongs to campus-api.
 */
export const LIVE_SESSIONS_QUERY = `select distinct family_id from refresh_tokens
  where family_id = any($1::uuid[])
    and revoked_at is null
    and expires_at > $3
    and created_at >= $2`;

/**
 * Must stay the same question campus-api's `isLiveMembership` asks, or the two
 * disagree about who belongs. $1 user, $2 cohort, $3 now.
 */
export const LIVE_MEMBERSHIP_QUERY = `select 1 from cohort_members
  where user_id = $1
    and cohort_id = $2
    and left_at is null
    and (role <> 'student' or status is not distinct from 'active')
    and (access_expires_at is null or access_expires_at > $3)
  limit 1`;

/**
 * Ids come from campus-api, so they are UUIDs. Anything else is dropped before
 * it reaches a query, where it would fail the cast rather than return nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string): boolean {
  return UUID.test(value);
}

/**
 * A session token says who someone was when they signed in; it cannot say
 * whether they still belong here. campus-api re-reads the row on every
 * request for exactly that reason, and a socket that lives for hours needs
 * the same answer — otherwise a ban takes effect whenever the token happens
 * to expire, which is up to AUTH_SESSION_TTL_MINUTES later.
 *
 * Raw SQL rather than drizzle: one query against two columns, of a table
 * campus-api owns. When world needs maps and spaces, the schema should move
 * to a shared package and this can move with it.
 */
export function createAccountLookup(env: Env): AccountLookup {
  const sql = postgres(env.DATABASE_URL, {
    max: env.WORLD_DB_POOL,
    // Read-only lookups on the hot path: fail fast rather than hold a socket
    // waiting on a database that is not answering.
    connect_timeout: 5,
  });

  return {
    async find(userId: string): Promise<Account | null> {
      const rows = await sql.unsafe<
        {
          id: string;
          status: string;
          system_role: string;
          session_epoch: number;
        }[]
      >(ACCOUNT_QUERY, [userId]);
      const row = rows[0];
      return row
        ? {
            id: row.id,
            suspended: row.status === 'suspended',
            sessionEpoch: row.session_epoch,
            admin: hasAdminPowers(row.system_role),
          }
        : null;
    },
    async liveSessions(sessionIds, refreshedSince, now): Promise<Set<string>> {
      const ids = [...new Set(sessionIds)].filter((id) => UUID.test(id));
      if (ids.length === 0) {
        return new Set();
      }
      const rows = await sql.unsafe<{ family_id: string }[]>(
        LIVE_SESSIONS_QUERY,
        [ids, refreshedSince, now],
      );
      return new Set(rows.map((row) => row.family_id));
    },
    async liveMembership(userId, cohortId, now): Promise<boolean> {
      if (!looksLikeId(cohortId)) {
        return false;
      }
      const rows = await sql.unsafe<unknown[]>(LIVE_MEMBERSHIP_QUERY, [
        userId,
        cohortId,
        now,
      ]);
      return rows.length > 0;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
