import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import { hasAdminPowers } from '../users/schema.js';
import { NoticeNotFoundException } from './notices.exceptions.js';
import { NoticeScope, notices } from './schema.js';

/**
 * The one definition of "notices this member can see".
 *
 * The list, the comment list and add-comment all reach notices through this
 * predicate, so they cannot drift. It always includes `removed_at is null`,
 * so a soft-removed notice disappears from all three at once.
 *
 * A member sees:
 *
 * - every campus notice, with any live membership;
 * - a cohort notice when one of their live memberships names that cohort;
 * - a cohort-track notice only when that membership names the exact
 *   `cohort_tracks` row — an exact match, not the underlying catalogue track;
 * - a mentorship-group notice when a live membership is the group's mentor or
 *   one of its students.
 *
 * All four roles count, including a guest. An ended, left or expired
 * membership does not. A person in several cohorts sees all of them. An admin
 * sees every non-removed notice without needing a membership.
 *
 * Memberships are read from the database on every call; nothing is taken from
 * the session token. The `now` passed here is the one the caller uses for the
 * whole request, so liveness cannot change between the page, its count and a
 * comment's check.
 */
export function noticesVisibleTo(
  db: DbExecutor,
  viewer: AuthenticatedUser,
  now: Date,
): SQL<unknown> {
  const notRemoved = isNull(notices.removedAt);

  if (hasAdminPowers(viewer.systemRole)) {
    return notRemoved;
  }

  return and(
    notRemoved,
    exists(
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
              and(
                eq(notices.scope, NoticeScope.MentorshipGroup),
                or(
                  exists(
                    db
                      .select({ one: sql`1` })
                      .from(mentorshipGroups)
                      .where(
                        and(
                          eq(mentorshipGroups.id, notices.mentorshipGroupId),
                          eq(mentorshipGroups.mentorMemberId, cohortMembers.id),
                        ),
                      ),
                  ),
                  exists(
                    db
                      .select({ one: sql`1` })
                      .from(mentorshipGroupStudents)
                      .where(
                        and(
                          eq(
                            mentorshipGroupStudents.mentorshipGroupId,
                            notices.mentorshipGroupId,
                          ),
                          eq(
                            mentorshipGroupStudents.cohortMemberId,
                            cohortMembers.id,
                          ),
                        ),
                      ),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
  ) as SQL<unknown>;
}

/** The same definition, narrowed to one notice. */
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

/**
 * Resolves a notice through the shared predicate, or refuses with the same
 * answer whether it does not exist or the caller may not see it. A missing
 * row and a hidden row are not distinguishable here, which is deliberate:
 * existence must not leak.
 *
 * `lock` takes a shared row lock for the caller's transaction. `add()` uses
 * it so a concurrent remove or re-scope, which takes `FOR UPDATE`, waits
 * until the comment and its audit entry have committed.
 */
export async function assertNoticeVisible(
  db: DbExecutor,
  viewer: AuthenticatedUser,
  noticeId: string,
  now: Date,
  lock = false,
): Promise<void> {
  const query = db
    .select({ id: notices.id })
    .from(notices)
    .where(noticeVisibleTo(db, viewer, noticeId, now))
    .limit(1);
  const [row] = lock ? await query.for('share') : await query;

  if (!row) {
    throw new NoticeNotFoundException(`Notice ${noticeId} not found`, {
      noticeId,
    });
  }
}
