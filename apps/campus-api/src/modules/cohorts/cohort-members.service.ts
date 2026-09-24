import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { StudentStatus, cohortMembers } from './schema.js';

@Injectable()
export class CohortMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A live place on the roster: not left, and not a student who has been
   * dismissed, graduated, withdrawn or deferred. A null status belongs to
   * professors and mentors, who carry none.
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
            isNull(cohortMembers.status),
            eq(cohortMembers.status, StudentStatus.Active),
          ),
        ),
      )
      .limit(1);

    return row !== undefined;
  }
}
