import { DESKS_CHANGED_CHANNEL } from '@campus/session';
import { and, isNull, sql, type SQL } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import {
  deskClaims,
  type DeskClaim,
  type DeskReleaseReason,
} from './schema.js';

/**
 * Ends every open claim `which` matches, for `reason`, and tells world about
 * each cohort it touched, unless the caller sends its own word.
 *
 * `claimed_at` is the database's clock and `now` the server's, so a release
 * is stamped no earlier than its claim: the release-window check would
 * refuse it otherwise.
 */
export async function endDeskClaims(
  tx: DbExecutor,
  which: SQL | undefined,
  reason: DeskReleaseReason,
  now: Date,
  { notify = true }: { notify?: boolean } = {},
): Promise<DeskClaim[]> {
  const ended = await tx
    .update(deskClaims)
    .set({
      releasedAt: sql`greatest(${deskClaims.claimedAt}, ${timestamptz(now)})`,
      releaseReason: reason,
    })
    .where(and(which, isNull(deskClaims.releasedAt)))
    .returning();
  if (notify) {
    await tellDesksChanged(
      tx,
      ended.map((claim) => claim.cohortId),
    );
  }
  return ended;
}

/**
 * Tells world who holds a desk may have changed: in these cohorts, or in
 * every cohort with `'all'`. Sent on commit, so world never reads ahead of
 * the change; a rolled-back transaction sends nothing.
 */
export async function tellDesksChanged(
  tx: DbExecutor,
  cohortIds: readonly string[] | 'all',
): Promise<void> {
  const payloads = cohortIds === 'all' ? [''] : [...new Set(cohortIds)];
  if (payloads.length === 0) return;
  await tx.execute(
    sql`select ${sql.join(
      payloads.map(
        (payload) => sql`pg_notify(${DESKS_CHANGED_CHANNEL}, ${payload})`,
      ),
      sql`, `,
    )}`,
  );
}
