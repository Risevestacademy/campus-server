import type { NotificationCreated } from '@campus/session';
import { Inject, Injectable } from '@nestjs/common';
import {
  type SQL,
  and,
  count,
  desc,
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
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
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
import type {
  ListNotificationsQueryDto,
  NotificationDto,
} from './dto/notification.dto.js';
import { NotificationNotFoundException } from './notifications.exceptions.js';
import {
  type EntryRequestContext,
  NotificationKind,
  NotificationReferenceType,
  notifications,
  type Notification,
} from './schema.js';

export interface NotificationReference {
  type: NotificationReferenceType;
  id: string;
}

export interface NotifyInput {
  recipientId: string;
  /** Where it happened, so only that cohort's socket is pushed it; null for every socket. */
  cohortId: string | null;
  kind: NotificationKind;
  reference: NotificationReference;
  context?: EntryRequestContext;
}

/**
 * Notifications, both sides. Callers audit the event that caused one; the
 * notifications themselves are not audited.
 *
 * The writes answer what they wrote, for the caller to hand to
 * NotificationPush once its transaction has committed.
 *
 * Duplicates are skipped with ON CONFLICT on the unique index rather than by
 * catching 23505: inside a transaction a caught unique violation still aborts
 * it, and every caller here runs in the triggering event's transaction. A
 * skipped duplicate is not answered, so it is never pushed twice.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async notify(
    input: NotifyInput,
    executor: DbExecutor = this.db,
  ): Promise<NotificationCreated[]> {
    const rows = await executor
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        kind: input.kind,
        referenceType: input.reference.type,
        referenceId: input.reference.id,
        context: input.context,
      })
      .onConflictDoNothing({ target: UNIQUE_TARGET })
      .returning();
    return rows.map((row) => created(row, input.cohortId));
  }

  /** Everybody the notice reaches whose account is active, in one statement. */
  async notifyNoticePosted(
    notice: Pick<Notice, 'id'> & NoticeTarget,
    executor: DbExecutor = this.db,
    now: Date = new Date(),
  ): Promise<NotificationCreated[]> {
    const audience = noticeAudience(executor, notice, now).as('audience');
    const recipients = executor
      .selectDistinct({ userId: audience.userId })
      .from(audience)
      .innerJoin(users, eq(users.id, audience.userId))
      .where(eq(users.status, UserStatus.Active))
      .as('recipients');
    // Every column, in the table's order: drizzle refuses the statement at
    // run time if one is added there and not here.
    const rows = await executor
      .insert(notifications)
      .select((qb) =>
        qb
          .select({
            id: sql<string>`gen_random_uuid()`.as('id'),
            recipientId: recipients.userId,
            kind: sql<string>`${NotificationKind.NoticePosted}::varchar`.as(
              'kind',
            ),
            referenceType:
              sql<string>`${NotificationReferenceType.Notice}::varchar`.as(
                'reference_type',
              ),
            referenceId: sql<string>`${notice.id}::varchar`.as('reference_id'),
            context: sql<EntryRequestContext | null>`null::jsonb`.as('context'),
            readAt: sql<Date | null>`null::timestamptz`.as('read_at'),
            createdAt: sql<Date>`now()`.as('created_at'),
          })
          .from(recipients),
      )
      .onConflictDoNothing({ target: UNIQUE_TARGET })
      .returning();
    return rows.map((row) => created(row, notice.cohortId));
  }

  /** One page of the recipient's own, newest first. */
  async list(
    recipientId: string,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResponseDto<NotificationDto>> {
    const filter = and(
      eq(notifications.recipientId, recipientId),
      query.unread ? isNull(notifications.readAt) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(filter)
        // Every recipient of a notice gets the same instant; the id keeps pages apart.
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(notifications).where(filter),
    ]);

    return {
      items: rows.map(toDto),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  /**
   * Marks one of the recipient's own read. One already read is answered as
   * it is, keeping when it was first read. Somebody else's is answered as
   * if it did not exist.
   */
  async markRead(
    recipientId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<NotificationDto> {
    const own = and(
      eq(notifications.id, id),
      eq(notifications.recipientId, recipientId),
    );
    const [updated] = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(and(own, isNull(notifications.readAt)))
      .returning();
    if (updated) return toDto(updated);

    const [existing] = await this.db.select().from(notifications).where(own);
    if (!existing) {
      throw new NotificationNotFoundException(`Notification ${id} not found`, {
        notificationId: id,
      });
    }
    return toDto(existing);
  }

  /** Every unread one of the recipient's; answers how many that was. */
  async markAllRead(recipientId: string, now: Date = new Date()) {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return { marked: rows.length };
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

function created(
  row: Notification,
  cohortId: string | null,
): NotificationCreated {
  return {
    recipientId: row.recipientId,
    cohortId,
    id: row.id,
    kind: row.kind,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    context: row.context ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDto(row: Notification): NotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    context: row.context ?? null,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  };
}

/**
 * Who a notice reaches, as one `user_id` column. Live memberships only; the
 * caller drops accounts that are not active.
 */
function noticeAudience(db: DbExecutor, notice: NoticeTarget, now: Date) {
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
              isLiveMembership(now, studentMember),
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
