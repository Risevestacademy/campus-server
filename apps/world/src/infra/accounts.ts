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
  close(): Promise<void>;
}

export interface Account {
  id: string;
  suspended: boolean;
}

/**
 * Exported so a test can run the very same statement against a real
 * PostgreSQL engine. The columns belong to campus-api's migration, and a
 * rename there would otherwise only surface as every socket refusing a
 * perfectly good session.
 */
export const ACCOUNT_QUERY =
  'select id, status from users where id = $1 limit 1';

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
      const rows = await sql.unsafe<{ id: string; status: string }[]>(
        ACCOUNT_QUERY,
        [userId],
      );
      const row = rows[0];
      return row ? { id: row.id, suspended: row.status === 'suspended' } : null;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
