import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../../modules/cohorts/cohort-members.service.js';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
} from '../../modules/cohorts/schema.js';
import { mentorshipGroups } from '../../modules/mentorship-groups/schema.js';

/** The membership a cohort-role guard matched, for the handler to reuse. */
export interface CohortMembership {
  id: string;
  cohortId: string;
  role: CohortRole;
  cohortTrackId: string | null;
  mentorshipGroupId: string | null;
}

const membershipFields = {
  id: cohortMembers.id,
  cohortId: cohortMembers.cohortId,
  role: cohortMembers.role,
  cohortTrackId: cohortMembers.cohortTrackId,
};

/**
 * The database half of the cohort-role guards: one indexed lookup per check.
 *
 * A membership is live by the same rule sign-in and enrolment use, so ending
 * it takes effect on the next request. The joins also settle the route's
 * claims: a professor's track has to be one this cohort runs, and a mentor's
 * group has to belong to this cohort.
 */
@Injectable()
export class CohortRoleService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async findProfessorOfTrack(
    userId: string,
    cohortId: string,
    trackId: string,
    now: Date = new Date(),
  ): Promise<CohortMembership | null> {
    const [row] = await this.db
      .select(membershipFields)
      .from(cohortMembers)
      .innerJoin(
        cohortTracks,
        and(
          eq(cohortTracks.id, cohortMembers.cohortTrackId),
          eq(cohortTracks.cohortId, cohortMembers.cohortId),
        ),
      )
      .where(
        and(
          eq(cohortMembers.userId, userId),
          eq(cohortMembers.cohortId, cohortId),
          eq(cohortMembers.role, CohortRole.Professor),
          eq(cohortTracks.trackId, trackId),
          isLiveMembership(now),
        ),
      )
      .limit(1);

    return row ? { ...row, mentorshipGroupId: null } : null;
  }

  async findMentorOfGroup(
    userId: string,
    cohortId: string,
    groupId: string,
    now: Date = new Date(),
  ): Promise<CohortMembership | null> {
    const [row] = await this.db
      .select({
        ...membershipFields,
        mentorshipGroupId: mentorshipGroups.id,
      })
      .from(cohortMembers)
      .innerJoin(
        mentorshipGroups,
        and(
          eq(mentorshipGroups.mentorMemberId, cohortMembers.id),
          eq(mentorshipGroups.cohortId, cohortMembers.cohortId),
        ),
      )
      .where(
        and(
          eq(cohortMembers.userId, userId),
          eq(cohortMembers.cohortId, cohortId),
          eq(cohortMembers.role, CohortRole.Mentor),
          eq(mentorshipGroups.id, groupId),
          isLiveMembership(now),
        ),
      )
      .limit(1);

    return row ?? null;
  }
}
