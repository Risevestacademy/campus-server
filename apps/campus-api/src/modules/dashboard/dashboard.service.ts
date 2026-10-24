import { Inject, Injectable } from '@nestjs/common';
import { and, count, countDistinct, eq, gt } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { assertCohortExists } from '../cohorts/assert-cohort-exists.js';
import { CohortRole, cohortMembers } from '../cohorts/schema.js';
import { InviteStatus, invites } from '../invites/schema.js';
import type {
  DashboardFiguresDto,
  MembersByRoleDto,
} from './dto/dashboard-figures.dto.js';

/** The admin dashboard's figures. Who is online now comes from world. */
@Injectable()
export class DashboardService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async figures(
    cohortId?: string,
    now: Date = new Date(),
  ): Promise<DashboardFiguresDto> {
    if (cohortId !== undefined) {
      await assertCohortExists(this.db, cohortId);
    }

    const live = and(
      isLiveMembership(now),
      cohortId === undefined ? undefined : eq(cohortMembers.cohortId, cohortId),
    );
    const [[members], roles, [invited]] = await Promise.all([
      this.db
        .select({ total: countDistinct(cohortMembers.userId) })
        .from(cohortMembers)
        .where(live),
      this.db
        .select({
          role: cohortMembers.role,
          people: countDistinct(cohortMembers.userId),
        })
        .from(cohortMembers)
        .where(live)
        .groupBy(cohortMembers.role),
      this.db
        .select({ pending: count() })
        .from(invites)
        .where(
          and(
            eq(invites.status, InviteStatus.Pending),
            gt(invites.expiresAt, now),
            cohortId === undefined ? undefined : eq(invites.cohortId, cohortId),
          ),
        ),
    ]);

    const byRole: MembersByRoleDto = {
      [CohortRole.Student]: 0,
      [CohortRole.Professor]: 0,
      [CohortRole.Mentor]: 0,
      [CohortRole.Guest]: 0,
    };
    for (const { role, people } of roles) byRole[role] = people;
    return {
      members: { total: members.total, byRole },
      pendingInvites: invited.pending,
    };
  }
}
