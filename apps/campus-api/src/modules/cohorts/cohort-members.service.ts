import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';

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
  async hasActiveMembership(
    userId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
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
          // A guest's visit ends on its own; everybody else has no end date.
          or(
            isNull(cohortMembers.accessExpiresAt),
            gt(cohortMembers.accessExpiresAt, now),
          ),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * The soonest moment one of this user's live memberships stops counting,
   * or null when nothing they hold has an end date.
   *
   * Only guests carry one, so for everybody else this is null and the
   * session is minted at its normal length. It exists so a token cannot
   * outlive the access it represents: re-checking membership on every
   * request would cost a query per request and would still leave `world`,
   * which only validates the token, none the wiser.
   */
  async soonestAccessExpiry(
    userId: string,
    now: Date = new Date(),
  ): Promise<Date | null> {
    const [row] = await this.db
      .select({ endsAt: cohortMembers.accessExpiresAt })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, userId),
          isNull(cohortMembers.leftAt),
          isNotNull(cohortMembers.accessExpiresAt),
          gt(cohortMembers.accessExpiresAt, now),
        ),
      )
      .orderBy(cohortMembers.accessExpiresAt)
      .limit(1);

    return row?.endsAt ?? null;
  }
}
