import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../schema/index.js';

/**
 * A real PostgreSQL for the tests PGlite cannot run.
 *
 * PGlite is a whole engine, and nearly every database test here uses it. But
 * it serves one connection, so two transactions never overlap: a test of a
 * row lock passes on it whether or not the lock is there. Anything whose
 * point is what happens when two requests arrive together needs a server
 * with more than one connection.
 *
 * Set CAMPUS_TEST_DATABASE_URL to a database nothing else uses and those
 * tests run; leave it unset and they are skipped. CI sets it. The migrations
 * are applied to it once, before any test file starts (vitest.global-setup).
 *
 *     CAMPUS_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/campus_test pnpm test
 *
 * Test files share the database and run side by side, so a test makes its
 * own rows under names nobody else will pick (see `unique`) and leaves the
 * tables alone: no truncating, which would pull rows out from under a
 * neighbour.
 */
export const REAL_POSTGRES_URL = process.env.CAMPUS_TEST_DATABASE_URL;

/** A pool, so that calls made together really do run on separate connections. */
export function connectRealPostgres() {
  const client = postgres(REAL_POSTGRES_URL as string, {
    max: 10,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

/** A suffix no other test, file or run will produce. */
export function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
