import { SPACES_CHANGED_CHANNEL } from '@campus/space-access';
import { sql } from 'drizzle-orm';

import type { Tx } from '../../infra/database/database.constants.js';

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
