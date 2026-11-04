import { and, eq, exists, or, sql, type SQL } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import { hasAdminPowers } from '../users/schema.js';
import { NoticeScope, notices } from './schema.js';

/**
 * The one definition of "notices this member can see".
 *
 * The list, the comment list and add-comment all reach notices through this
 * predicate, so they cannot drift. A member sees a campus notice with any
 * live membership, a cohort notice with a live membership of that cohort, and
 * a track notice only when their membership names that exact cohort track.
 * All four cohort roles count, including a guest; an ended, left or expired
 * membership does not. An admin sees every notice.
 *
 * Memberships are read from the database on every call; nothing is taken from
 * the session token. The `now` passed here is the one the caller uses for the
 * whole request, so liveness cannot change between the page and its count.
 *
 * Notices cannot be removed on this branch (CO-31 has not landed). When its
 * `removed_at` column arrives, add `isNull(notices.removedAt)` here and every
 * route will inherit it.
 */
export function noticesVisibleTo(
  db: DbExecutor,
  viewer: AuthenticatedUser,
  now: Date,
): SQL<unknown> {
  if (hasAdminPowers(viewer.systemRole)) {
    return sql`true`;
  }

  return exists(
    db
      .select({ one: sql`1` })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, viewer.id),
          isLiveMembership(now),
          or(
            eq(notices.scope, NoticeScope.Campus),
            and(
              eq(notices.scope, NoticeScope.Cohort),
              eq(cohortMembers.cohortId, notices.cohortId),
            ),
            and(
              eq(notices.scope, NoticeScope.CohortTrack),
              eq(cohortMembers.cohortTrackId, notices.cohortTrackId),
            ),
          ),
        ),
      ),
  ) as SQL<unknown>;
}

/** One notice the member can see. The same definition, narrowed by id. */
export function noticeVisibleTo(
  db: DbExecutor,
  viewer: AuthenticatedUser,
  noticeId: string,
  now: Date,
): SQL<unknown> {
  return and(
    eq(notices.id, noticeId),
    noticesVisibleTo(db, viewer, now),
  ) as SQL<unknown>;
}
