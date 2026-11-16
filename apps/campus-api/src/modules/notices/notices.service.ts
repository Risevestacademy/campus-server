import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import {
  type AuditContext,
  changedFields,
  writeAuditEntry,
} from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortRole, cohortMembers, cohortTracks } from '../cohorts/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import { NotificationPush } from '../notifications/notification-push.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hasAdminPowers } from '../users/schema.js';
import type { CreateNoticeDto } from './dto/create-notice.dto.js';
import type { ListNoticesQueryDto } from './dto/list-notices.dto.js';
import type { NoticeResponseDto } from './dto/notice-response.dto.js';
import type { UpdateNoticeDto } from './dto/update-notice.dto.js';
import { noticesVisibleTo } from './notice-visibility.js';
import {
  NoticeConflictException,
  NoticeForbiddenException,
  NoticeInvalidArgumentException,
  NoticeNotFoundException,
} from './notices.exceptions.js';
import {
  NoticeScope,
  notices,
  type Notice,
  type NoticeTarget,
} from './schema.js';

const MAX_PINNED_PER_SCOPE = 3;
const NOTICE_AUDITED_FIELDS = ['title', 'body'] as const;

const noticeColumns = {
  id: notices.id,
  authorId: notices.authorId,
  scope: notices.scope,
  cohortId: notices.cohortId,
  cohortTrackId: notices.cohortTrackId,
  mentorshipGroupId: notices.mentorshipGroupId,
  title: notices.title,
  body: notices.body,
  pinned: notices.pinned,
  createdAt: notices.createdAt,
  updatedAt: notices.updatedAt,
};

@Injectable()
export class NoticesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly push: NotificationPush,
  ) {}

  /**
   * The notice wall: one page of the notices the caller can see.
   *
   * The whole visible result is ordered by pinned, then newest, then id
   * before it is paged. Pinned notices therefore lead globally, not just
   * within whichever page they happen to land on, and the id tie-break keeps
   * a page boundary from repeating or dropping a notice with the same
   * created_at.
   *
   * The page query and its count share one filter, including the visibility
   * predicate, so a notice the member may not see can never change total.
   */
  async list(
    viewer: AuthenticatedUser,
    query: ListNoticesQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResponseDto<NoticeResponseDto>> {
    const filter = and(
      noticesVisibleTo(this.db, viewer, now),
      query.scope ? eq(notices.scope, query.scope) : undefined,
      query.cohortId ? eq(notices.cohortId, query.cohortId) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select(noticeColumns)
        .from(notices)
        .where(filter)
        .orderBy(
          desc(notices.pinned),
          desc(notices.createdAt),
          desc(notices.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(notices).where(filter),
    ]);

    return {
      items: rows.map((row) => ({
        ...row,
        scope: row.scope as NoticeScope,
      })),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  async create(
    dto: CreateNoticeDto,
    actor: AuthenticatedUser,
    audit: AuditContext,
  ): Promise<Notice> {
    this.validateScopeReferences(dto);
    // Validation has refused any reference the scope does not take.
    const target: NoticeTarget = {
      scope: dto.scope,
      cohortId: dto.cohortId ?? null,
      cohortTrackId: dto.cohortTrackId ?? null,
      mentorshipGroupId: dto.mentorshipGroupId ?? null,
    };
    await this.assertCanManageNotices(this.db, actor, target);

    const { row, created } = await this.db.transaction(async (tx) => {
      if (target.cohortTrackId) {
        await this.assertCohortTrackExists(
          tx,
          target.cohortTrackId,
          target.cohortId!,
        );
      }
      if (target.mentorshipGroupId) {
        await this.assertMentorshipGroupExists(
          tx,
          target.mentorshipGroupId,
          target.cohortId!,
        );
      }

      const [row] = await tx
        .insert(notices)
        .values({
          ...target,
          authorId: actor.id,
          title: dto.title,
          body: dto.body,
        })
        .returning();

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.NoticeCreated,
        subject: { type: AuditSubjectType.Notice, id: row.id },
        details: {
          scope: row.scope,
          cohortId: row.cohortId,
          cohortTrackId: row.cohortTrackId,
          mentorshipGroupId: row.mentorshipGroupId,
          title: row.title,
        },
      });
      const created = await this.notifications.notifyNoticePosted(row, tx);

      return { row, created };
    });
    void this.push.send(created);
    return row;
  }

  async update(
    id: string,
    dto: UpdateNoticeDto,
    actor: AuthenticatedUser,
    audit: AuditContext,
  ): Promise<Notice> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(notices)
        .where(and(eq(notices.id, id), isNull(notices.removedAt)))
        .for('update');

      if (!existing) {
        throw new NoticeNotFoundException(`Notice ${id} not found`, {
          noticeId: id,
        });
      }

      await this.assertCanManageNotices(tx, actor, existing);

      if (dto.title === undefined && dto.body === undefined) {
        return existing;
      }

      const [row] = await tx
        .update(notices)
        .set({
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.body !== undefined ? { body: dto.body } : {}),
        })
        .where(eq(notices.id, id))
        .returning();

      const changes = changedFields(existing, row, NOTICE_AUDITED_FIELDS);
      if (Object.keys(changes).length > 0) {
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.NoticeUpdated,
          subject: { type: AuditSubjectType.Notice, id },
          details: { changes },
        });
      }
      return row;
    });
  }

  async pin(
    id: string,
    pinned: boolean,
    actor: AuthenticatedUser,
    audit: AuditContext,
  ): Promise<Notice> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(notices)
        .where(and(eq(notices.id, id), isNull(notices.removedAt)))
        .for('update');

      if (!existing) {
        throw new NoticeNotFoundException(`Notice ${id} not found`, {
          noticeId: id,
        });
      }

      await this.assertCanManageNotices(tx, actor, existing);

      if (existing.pinned === pinned) {
        return existing;
      }

      if (pinned) {
        // The row lock above covers only this notice: hold the scope's lock
        // until commit so two pins in one scope count one after the other.
        await this.lockScopePins(tx, existing);
        const pinnedInScope = await this.countPinnedInScope(tx, existing);

        if (pinnedInScope >= MAX_PINNED_PER_SCOPE) {
          throw new NoticeConflictException(
            `Cannot pin more than ${MAX_PINNED_PER_SCOPE} notices in the same scope`,
            { scope: existing.scope, limit: MAX_PINNED_PER_SCOPE },
          );
        }
      }

      const [row] = await tx
        .update(notices)
        .set({ pinned })
        .where(eq(notices.id, id))
        .returning();

      await writeAuditEntry(tx, {
        ...audit,
        action: pinned ? AuditAction.NoticePinned : AuditAction.NoticeUnpinned,
        subject: { type: AuditSubjectType.Notice, id },
        details: { scope: existing.scope, cohortId: existing.cohortId },
      });

      return row;
    });
  }

  async remove(
    id: string,
    actor: AuthenticatedUser,
    audit: AuditContext,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(notices)
        .where(and(eq(notices.id, id), isNull(notices.removedAt)))
        .for('update');

      if (!existing) {
        throw new NoticeNotFoundException(`Notice ${id} not found`, {
          noticeId: id,
        });
      }

      await this.assertCanManageNotices(tx, actor, existing);

      await tx
        .update(notices)
        .set({ removedAt: new Date(), pinned: false })
        .where(eq(notices.id, id));

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.NoticeRemoved,
        subject: { type: AuditSubjectType.Notice, id },
        details: {
          scope: existing.scope,
          cohortId: existing.cohortId,
          title: existing.title,
        },
      });
    });
  }

  private validateScopeReferences(dto: CreateNoticeDto): void {
    const { scope } = dto;
    const refuse = (message: string): never => {
      throw new NoticeInvalidArgumentException(message, { scope });
    };

    if (scope === NoticeScope.Campus) {
      if (dto.cohortId) refuse('campus-scoped notices must not name a cohort');
    } else if (!dto.cohortId) {
      refuse(`${scope}-scoped notices require a cohort`);
    }

    if (scope === NoticeScope.CohortTrack) {
      if (!dto.cohortTrackId) {
        refuse('cohort-track-scoped notices require a cohort track');
      }
    } else if (dto.cohortTrackId) {
      refuse(`${scope}-scoped notices must not name a cohort track`);
    }

    if (scope === NoticeScope.MentorshipGroup) {
      if (!dto.mentorshipGroupId) {
        refuse('mentorship-group-scoped notices require a mentorship group');
      }
    } else if (dto.mentorshipGroupId) {
      refuse(`${scope}-scoped notices must not name a mentorship group`);
    }
  }

  /**
   * Each role reaches only the people it answers for: admins anyone, a
   * professor the track their own membership names, a mentor their pod.
   *
   * Reads through `db`, so callers inside a transaction pass it rather than
   * taking a second pool connection while theirs is held.
   */
  private async assertCanManageNotices(
    db: DbExecutor,
    actor: AuthenticatedUser,
    target: NoticeTarget,
    now: Date = new Date(),
  ): Promise<void> {
    if (hasAdminPowers(actor.systemRole)) {
      return;
    }

    switch (target.scope as NoticeScope) {
      case NoticeScope.CohortTrack: {
        const [professor] = await db
          .select({ id: cohortMembers.id })
          .from(cohortMembers)
          .where(
            and(
              eq(cohortMembers.userId, actor.id),
              eq(cohortMembers.cohortId, target.cohortId!),
              eq(cohortMembers.cohortTrackId, target.cohortTrackId!),
              eq(cohortMembers.role, CohortRole.Professor),
              isLiveMembership(now),
            ),
          );
        if (professor) return;
        throw new NoticeForbiddenException(
          "Only admins and the track's professors may manage its notices",
        );
      }
      case NoticeScope.MentorshipGroup: {
        const [mentor] = await db
          .select({ id: mentorshipGroups.id })
          .from(mentorshipGroups)
          .innerJoin(
            cohortMembers,
            eq(cohortMembers.id, mentorshipGroups.mentorMemberId),
          )
          .where(
            and(
              eq(mentorshipGroups.id, target.mentorshipGroupId!),
              eq(cohortMembers.userId, actor.id),
              isLiveMembership(now),
            ),
          );
        if (mentor) return;
        throw new NoticeForbiddenException(
          "Only admins and the group's mentor may manage its notices",
        );
      }
      default:
        throw new NoticeForbiddenException(
          `Only admins may manage ${target.scope}-wide notices`,
        );
    }
  }

  private async assertCohortTrackExists(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    cohortTrackId: string,
    cohortId: string,
  ): Promise<void> {
    const [ct] = await tx
      .select({ id: cohortTracks.id })
      .from(cohortTracks)
      .where(
        and(
          eq(cohortTracks.id, cohortTrackId),
          eq(cohortTracks.cohortId, cohortId),
        ),
      );

    if (!ct) {
      throw new NoticeInvalidArgumentException(
        'The cohort track does not belong to the given cohort',
        { cohortTrackId, cohortId },
      );
    }
  }

  private async assertMentorshipGroupExists(
    tx: DbExecutor,
    mentorshipGroupId: string,
    cohortId: string,
  ): Promise<void> {
    const [group] = await tx
      .select({ id: mentorshipGroups.id })
      .from(mentorshipGroups)
      .where(
        and(
          eq(mentorshipGroups.id, mentorshipGroupId),
          eq(mentorshipGroups.cohortId, cohortId),
        ),
      );

    if (!group) {
      throw new NoticeInvalidArgumentException(
        'The mentorship group does not belong to the given cohort',
        { mentorshipGroupId, cohortId },
      );
    }
  }

  /**
   * A transaction-scoped advisory lock on one scope's pins, released at
   * commit or rollback. Campus notices have no row to lock, hence a key.
   */
  private async lockScopePins(
    tx: DbExecutor,
    target: NoticeTarget,
  ): Promise<void> {
    const key = `notices:pins:${target.scope}:${
      target.mentorshipGroupId ?? target.cohortTrackId ?? target.cohortId ?? '-'
    }`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  private async countPinnedInScope(
    tx: DbExecutor,
    target: NoticeTarget,
  ): Promise<number> {
    const conditions = [
      eq(notices.pinned, true),
      isNull(notices.removedAt),
      eq(notices.scope, target.scope),
    ];

    if (target.mentorshipGroupId) {
      conditions.push(eq(notices.mentorshipGroupId, target.mentorshipGroupId));
    } else if (target.cohortTrackId) {
      conditions.push(eq(notices.cohortTrackId, target.cohortTrackId));
    } else if (target.cohortId) {
      conditions.push(eq(notices.cohortId, target.cohortId));
    }

    const [{ total }] = await tx
      .select({ total: count() })
      .from(notices)
      .where(and(...conditions));

    return total;
  }
}
