import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, or } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { CohortRole, StudentStatus, cohortMembers } from './schema.js';

@Injectable()
export class CohortMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A live place on the roster, and the answer to whether somebody may sign
   * in without an invite — so it fails closed. Staff qualify on role alone,
   * since status is the student half of the table and they never carry one.
   * A student qualifies only while explicitly active: a row left unclassified
   * is a half-finished enrolment, not a standing invitation.
   */
  async hasActiveMembership(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: cohortMembers.id })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, userId),
          isNull(cohortMembers.leftAt),
          or(
            ne(cohortMembers.role, CohortRole.Student),
            eq(cohortMembers.status, StudentStatus.Active),
          ),
        ),
      )
      .limit(1);

    return row !== undefined;
  }
}
