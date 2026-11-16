import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers, cohorts, cohortTracks } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import type { UserMembershipDto } from './dto/user-list-item.dto.js';

/**
 * Each person's live memberships, most recently joined first, labelled with
 * the cohort and track so a screen can show them as they are.
 *
 * One query for however many people are asked about. Shared by the admin
 * list and the profile routes, so "which cohorts is this person in" has one
 * answer wherever it is asked.
 */
export async function loadLiveMemberships(
  db: DbExecutor,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, UserMembershipDto[]>> {
  const byUser = new Map<string, UserMembershipDto[]>();
  if (userIds.length === 0) {
    return byUser;
  }

  const rows = await db
    .select({
      userId: cohortMembers.userId,
      cohort: { id: cohorts.id, name: cohorts.name, code: cohorts.code },
      track: { id: tracks.id, name: tracks.name, code: tracks.code },
      role: cohortMembers.role,
      status: cohortMembers.status,
      joinedAt: cohortMembers.joinedAt,
      accessExpiresAt: cohortMembers.accessExpiresAt,
    })
    .from(cohortMembers)
    .innerJoin(cohorts, eq(cohorts.id, cohortMembers.cohortId))
    .leftJoin(cohortTracks, eq(cohortTracks.id, cohortMembers.cohortTrackId))
    .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
    .where(
      and(inArray(cohortMembers.userId, [...userIds]), isLiveMembership(now)),
    )
    // The order CohortMembersService lists a person's cohorts in.
    .orderBy(desc(cohortMembers.joinedAt), asc(cohortMembers.cohortId));

  for (const { userId, ...membership } of rows) {
    const list = byUser.get(userId) ?? [];
    list.push(membership);
    byUser.set(userId, list);
  }
  return byUser;
}
