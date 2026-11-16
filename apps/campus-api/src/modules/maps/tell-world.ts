import { SPACES_CHANGED_CHANNEL } from '@campus/space-access';
import { sql } from 'drizzle-orm';

import type {
  DbExecutor,
  Tx,
} from '../../infra/database/database.constants.js';

/**
 * How a map publish tells world which map changed. Its own token so a test
 * can make the notification fail without taking the database with it.
 */
export const MAPS_NOTIFY = Symbol('MAPS_NOTIFY');

export type MapNotifier = (
  executor: DbExecutor,
  mapKey: string,
) => Promise<void>;

/**
 * Something a space's door reads changed — a list, or the spaces themselves —
 * so world reads its spaces again. Postgres holds the notification until the
 * commit, so world never reads before the change is in, and never hears of
 * one that rolled back. Every writer of spaces or lists calls this, in the
 * transaction that writes.
 */
export async function tellWorld(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_notify(${SPACES_CHANGED_CHANNEL}, '')`);
}

/**
 * Tells world which map an admin published. The same channel a space edit
 * uses: an empty payload still means "read the spaces again", and a map key
 * means "this map is live now". Sent after the publish has committed, so a
 * notification that fails cannot undo it.
 */
export async function tellWorldMap(
  executor: DbExecutor,
  mapKey: string,
): Promise<void> {
  await executor.execute(
    sql`select pg_notify(${SPACES_CHANGED_CHANNEL}, ${mapKey})`,
  );
}
