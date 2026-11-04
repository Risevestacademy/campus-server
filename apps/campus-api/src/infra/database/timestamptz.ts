import { sql, type SQL } from 'drizzle-orm';

/**
 * A time from the app, ready to sit in raw SQL. drizzle's postgres.js driver
 * turns off postgres.js's own date handling, so a bare `Date` in a `sql`
 * template is refused at run time; PGlite accepts it, so the tests there
 * would not notice.
 */
export function timestamptz(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}
