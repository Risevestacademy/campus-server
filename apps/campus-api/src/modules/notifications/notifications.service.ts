import { Inject, Injectable } from '@nestjs/common';
import {
  type SQL,
  type SQLWrapper,
  and,
  eq,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import { alias, union } from 'drizzle-orm/pg-core';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import {
  NoticeScope,
  type Notice,
  type NoticeTarget,
} from '../notices/schema.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import {
  NotificationKind,
  NotificationReferenceType,
  notifications,
} from './schema.js';

export interface NotificationReference {
  type: NotificationReferenceType;
  id: string;
}

export interface NotifyInput {
  recipientId: string;
  kind: NotificationKind;
  reference: NotificationReference;
}

/**
 * The write side of notifications. Callers audit the event that caused one;
 * the notifications themselves are not audited.
 *
 * Duplicates are skipped with ON CONFLICT on the unique index rather than by
 * catching 23505: inside a transaction a caught unique violation still aborts
 * it, and every caller here runs in the triggering event's transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async notify(input: NotifyInput, executor: DbExecutor = this.db) {
    await executor
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        kind: input.kind,
        referenceType: input.reference.type,
        referenceId: input.reference.id,
      })
      .onConflictDoNothing({ target: UNIQUE_TARGET });
  }

  /** Everybody the notice reaches whose account is active, in one statement. */
  async notifyNoticePosted(
    notice: Pick<Notice, 'id'> & NoticeTarget,
    executor: DbExecutor = this.db,
    now: Date = new Date(),
  ) {
    await executor.execute(sql`
      insert into ${notifications}
        (${sql.identifier(notifications.recipientId.name)},
         ${sql.identifier(notifications.kind.name)},
         ${sql.identifier(notifications.referenceType.name)},
         ${sql.identifier(notifications.referenceId.name)})
      select distinct audience.user_id,
        ${NotificationKind.NoticePosted}::varchar,
        ${NotificationReferenceType.Notice}::varchar,
        ${notice.id}::varchar
      from (${noticeAudience(executor, notice, now)}) as audience
      inner join ${users} on ${users.id} = audience.user_id
      where ${users.status} = ${UserStatus.Active}
      on conflict (${sql.join(
        UNIQUE_TARGET.map((column) => sql.identifier(column.name)),
        sql`, `,
      )}) do nothing`);
  }
}

const UNIQUE_TARGET = [
  notifications.recipientId,
  notifications.kind,
  notifications.referenceType,
  notifications.referenceId,
];

/** The roles `hasAdminPowers` accepts. */
const ADMIN_ROLES = [SystemRole.Admin, SystemRole.SuperAdmin];

const studentMember = alias(cohortMembers, 'student_member');

/**
 * Who a notice reaches, as one `user_id` column. Live memberships only; the
 * caller drops accounts that are not active.
 */
function noticeAudience(
  db: DbExecutor,
  notice: NoticeTarget,
  now: Date,
): SQLWrapper {
  const live = isLiveMembership(now);
  const members = (where?: SQL) =>
    db
      .select({ userId: cohortMembers.userId })
      .from(cohortMembers)
      .where(and(live, where));

  switch (notice.scope as NoticeScope) {
    case NoticeScope.Campus:
      // Admins need no membership to run the campus, so they are added here.
      return union(
        members(),
        db
          .select({ userId: users.id })
          .from(users)
          .where(inArray(users.systemRole, ADMIN_ROLES)),
      );
    case NoticeScope.Cohort:
      return members(eq(cohortMembers.cohortId, notice.cohortId!));
    case NoticeScope.CohortTrack:
      // Staff rarely name a track on their membership, so a track's mentors
      // are also found through the students in their pods.
      return union(
        members(
          and(
            eq(cohortMembers.cohortId, notice.cohortId!),
            eq(cohortMembers.cohortTrackId, notice.cohortTrackId!),
          ),
        ),
        db
          .select({ userId: cohortMembers.userId })
          .from(mentorshipGroups)
          .innerJoin(
            cohortMembers,
            eq(cohortMembers.id, mentorshipGroups.mentorMemberId),
          )
          .innerJoin(
            mentorshipGroupStudents,
            eq(mentorshipGroupStudents.mentorshipGroupId, mentorshipGroups.id),
          )
          .innerJoin(
            studentMember,
            eq(studentMember.id, mentorshipGroupStudents.cohortMemberId),
          )
          .where(
            and(
              eq(mentorshipGroups.cohortId, notice.cohortId!),
              eq(studentMember.cohortTrackId, notice.cohortTrackId!),
              isNull(studentMember.leftAt),
              live,
            ),
          ),
      );
    case NoticeScope.MentorshipGroup:
      return union(
        db
          .select({ userId: cohortMembers.userId })
          .from(mentorshipGroups)
          .innerJoin(
            cohortMembers,
            eq(cohortMembers.id, mentorshipGroups.mentorMemberId),
          )
          .where(and(eq(mentorshipGroups.id, notice.mentorshipGroupId!), live)),
        db
          .select({ userId: cohortMembers.userId })
          .from(mentorshipGroupStudents)
          .innerJoin(
            cohortMembers,
            eq(cohortMembers.id, mentorshipGroupStudents.cohortMemberId),
          )
          .where(
            and(
              eq(
                mentorshipGroupStudents.mentorshipGroupId,
                notice.mentorshipGroupId!,
              ),
              live,
            ),
          ),
      );
    default:
      throw new Error(`Unknown notice scope: ${notice.scope}`);
  }
}
