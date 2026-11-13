import type {
  CohortMembershipFacts,
  PersonFacts,
  SpaceFacts,
} from '@campus/space-access';
import { and, eq, sql } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import { CohortRole, cohortMembers } from '../cohorts/schema.js';
import { spaceMemberships, spaces } from '../maps/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import { UserStatus, users } from '../users/schema.js';

/**
 * The person as `mayEnter` reads them, for one cohort: null for an account
 * that is gone or suspended. The group comes from wherever the membership
 * holds one, as world's `MEMBERSHIP_ROWS_QUERY` reads it.
 */
export async function personFacts(
  db: DbExecutor,
  userId: string,
  cohortId: string,
): Promise<PersonFacts | null> {
  const [account] = await db
    .select({ systemRole: users.systemRole, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  if (!account || account.status === UserStatus.Suspended) return null;

  const [member] = await db
    .select({
      role: cohortMembers.role,
      leftAt: cohortMembers.leftAt,
      status: cohortMembers.status,
      accessExpiresAt: cohortMembers.accessExpiresAt,
      trackId: cohortMembers.cohortTrackId,
      mentorshipGroupId: sql<
        string | null
      >`coalesce(${mentorshipGroupStudents.mentorshipGroupId}, ${mentorshipGroups.id})`,
    })
    .from(cohortMembers)
    .leftJoin(
      mentorshipGroupStudents,
      and(
        eq(mentorshipGroupStudents.cohortMemberId, cohortMembers.id),
        eq(mentorshipGroupStudents.cohortId, cohortMembers.cohortId),
        eq(cohortMembers.role, CohortRole.Student),
      ),
    )
    .leftJoin(
      mentorshipGroups,
      and(
        eq(mentorshipGroups.mentorMemberId, cohortMembers.id),
        eq(mentorshipGroups.cohortId, cohortMembers.cohortId),
        eq(cohortMembers.role, CohortRole.Mentor),
      ),
    )
    .where(
      and(
        eq(cohortMembers.userId, userId),
        eq(cohortMembers.cohortId, cohortId),
      ),
    );

  const membership: CohortMembershipFacts | null = member
    ? { cohortId, ...member }
    : null;
  return { userId, systemRole: account.systemRole, cohortId, membership };
}

/** The space as `mayEnter` reads it, with its whole list; null for no such space. */
export async function spaceFacts(
  db: DbExecutor,
  spaceId: string,
): Promise<SpaceFacts | null> {
  const [space] = await db
    .select({
      kind: spaces.kind,
      access: spaces.access,
      retiredAt: spaces.retiredAt,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId));
  if (!space) return null;

  const grants = await db
    .select({
      toUserId: spaceMemberships.userId,
      toTrackId: spaceMemberships.cohortTrackId,
      toCohortRole: spaceMemberships.cohortRole,
      toSystemRole: spaceMemberships.systemRole,
      toGroupId: spaceMemberships.mentorshipGroupId,
      validFrom: spaceMemberships.validFrom,
      validTo: spaceMemberships.validTo,
    })
    .from(spaceMemberships)
    .where(eq(spaceMemberships.spaceId, spaceId));

  // Locks live in world, and a recording is about who may come in at all.
  return { ...space, locked: false, grants };
}
