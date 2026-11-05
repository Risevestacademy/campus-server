import type { NotificationCreated } from '@campus/session';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import { NoticeScope, type Notice } from '../notices/schema.js';
import type {
  ListNotificationsQueryDto,
  NotificationDto,
} from './dto/notification.dto.js';
import { NotificationNotFoundException } from './notifications.exceptions.js';
import {
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
      })
      .onConflictDoNothing({ target: UNIQUE_TARGET })
      .returning();
    return rows.map((row) => created(row, input.cohortId));
  }

  /** Every live member in the notice's scope, in one statement. */
  async notifyNoticePosted(
    notice: Pick<Notice, 'id' | 'scope' | 'cohortId' | 'cohortTrackId'>,
    executor: DbExecutor = this.db,
    now: Date = new Date(),
  ): Promise<NotificationCreated[]> {
    const recipients = executor
      .selectDistinct({ userId: cohortMembers.userId })
      .from(cohortMembers)
      .where(and(isLiveMembership(now), scopeFilter(notice)))
      .as('recipients');
    // Every column, in the table's order: drizzle refuses the statement if
    // one is added there and not here.
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
    createdAt: row.createdAt.toISOString(),
  };
}

function toDto(row: Notification): NotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  };
}

function scopeFilter(
  notice: Pick<Notice, 'scope' | 'cohortId' | 'cohortTrackId'>,
): SQL | undefined {
  switch (notice.scope as NoticeScope) {
    case NoticeScope.Campus:
      return undefined;
    case NoticeScope.Cohort:
      return eq(cohortMembers.cohortId, notice.cohortId as string);
    case NoticeScope.CohortTrack:
      return and(
        eq(cohortMembers.cohortId, notice.cohortId as string),
        eq(cohortMembers.cohortTrackId, notice.cohortTrackId as string),
      );
    default:
      throw new Error(`Unknown notice scope: ${notice.scope}`);
  }
}
