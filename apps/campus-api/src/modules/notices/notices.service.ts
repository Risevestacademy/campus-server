import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import {
  type AuditContext,
  changedFields,
  writeAuditEntry,
} from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { CohortRole, cohortMembers, cohortTracks } from '../cohorts/schema.js';
import { NotificationPush } from '../notifications/notification-push.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hasAdminPowers } from '../users/schema.js';
import type { CreateNoticeDto } from './dto/create-notice.dto.js';
import type { UpdateNoticeDto } from './dto/update-notice.dto.js';
import {
  NoticeConflictException,
  NoticeForbiddenException,
  NoticeInvalidArgumentException,
  NoticeNotFoundException,
} from './notices.exceptions.js';
import { NoticeScope, notices, type Notice } from './schema.js';

const MAX_PINNED_PER_SCOPE = 3;
const NOTICE_AUDITED_FIELDS = ['title', 'body'] as const;

@Injectable()
export class NoticesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly push: NotificationPush,
  ) {}

  async create(
    dto: CreateNoticeDto,
    actor: AuthenticatedUser,
    audit: AuditContext,
  ): Promise<Notice> {
    this.validateScopeReferences(dto);
    await this.assertCanManageNotices(
      this.db,
      actor,
      dto.scope,
      dto.cohortId ?? null,
    );

    const { row, created } = await this.db.transaction(async (tx) => {
      if (dto.cohortTrackId) {
        await this.assertCohortTrackExists(
          tx,
          dto.cohortTrackId,
          dto.cohortId!,
        );
      }

      const [row] = await tx
        .insert(notices)
        .values({
          authorId: actor.id,
          scope: dto.scope,
          cohortId: dto.scope === NoticeScope.Campus ? null : dto.cohortId!,
          cohortTrackId:
            dto.scope === NoticeScope.CohortTrack ? dto.cohortTrackId! : null,
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

      await this.assertCanManageNotices(
        tx,
        actor,
        existing.scope as NoticeScope,
        existing.cohortId,
      );

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

      await this.assertCanManageNotices(
        tx,
        actor,
        existing.scope as NoticeScope,
        existing.cohortId,
      );

      if (existing.pinned === pinned) {
        return existing;
      }

      if (pinned) {
        // The row lock above covers only this notice: hold the scope's lock
        // until commit so two pins in one scope count one after the other.
        await this.lockScopePins(
          tx,
          existing.scope as NoticeScope,
          existing.cohortId,
          existing.cohortTrackId,
        );
        const pinnedInScope = await this.countPinnedInScope(
          tx,
          existing.scope as NoticeScope,
          existing.cohortId,
          existing.cohortTrackId,
        );

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

      await this.assertCanManageNotices(
        tx,
        actor,
        existing.scope as NoticeScope,
        existing.cohortId,
      );

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
    if (dto.scope === NoticeScope.Campus) {
      if (dto.cohortId) {
        throw new NoticeInvalidArgumentException(
          'Campus-scoped notices must not name a cohort',
          { scope: dto.scope },
        );
      }
      if (dto.cohortTrackId) {
        throw new NoticeInvalidArgumentException(
          'Campus-scoped notices must not name a cohort track',
          { scope: dto.scope },
        );
      }
    }

    if (
      dto.scope === NoticeScope.Cohort ||
      dto.scope === NoticeScope.CohortTrack
    ) {
      if (!dto.cohortId) {
        throw new NoticeInvalidArgumentException(
          `${dto.scope}-scoped notices require a cohort`,
          { scope: dto.scope },
        );
      }
    }

    if (dto.scope === NoticeScope.CohortTrack && !dto.cohortTrackId) {
      throw new NoticeInvalidArgumentException(
        'cohort-track-scoped notices require a cohort track',
        { scope: dto.scope },
      );
    }

    if (dto.scope === NoticeScope.Cohort && dto.cohortTrackId) {
      throw new NoticeInvalidArgumentException(
        'Cohort-scoped notices must not name a cohort track',
        { scope: dto.scope },
      );
    }
  }

  /**
   * Reads through `db`, so callers inside a transaction pass it rather than
   * taking a second pool connection while theirs is held.
   */
  private async assertCanManageNotices(
    db: DbExecutor,
    actor: AuthenticatedUser,
    scope: NoticeScope,
    cohortId: string | null,
  ): Promise<void> {
    if (hasAdminPowers(actor.systemRole)) {
      return;
    }

    if (scope === NoticeScope.Campus) {
      throw new NoticeForbiddenException(
        'Only admins may post campus-wide notices',
      );
    }

    if (!cohortId) {
      throw new NoticeForbiddenException(
        'Only admins may post notices without a cohort',
      );
    }

    const [membership] = await db
      .select({ role: cohortMembers.role })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, actor.id),
          eq(cohortMembers.cohortId, cohortId),
          isNull(cohortMembers.leftAt),
        ),
      );

    if (!membership || membership.role !== CohortRole.Professor) {
      throw new NoticeForbiddenException(
        'Only admins and professors of the cohort may manage its notices',
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

  /**
   * A transaction-scoped advisory lock on one scope's pins, released at
   * commit or rollback. Campus notices have no row to lock, hence a key.
   */
  private async lockScopePins(
    tx: DbExecutor,
    scope: NoticeScope,
    cohortId: string | null,
    cohortTrackId: string | null,
  ): Promise<void> {
    const key = `notices:pins:${scope}:${cohortTrackId ?? cohortId ?? '-'}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  private async countPinnedInScope(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    scope: NoticeScope,
    cohortId: string | null,
    cohortTrackId: string | null,
  ): Promise<number> {
    const conditions = [
      eq(notices.pinned, true),
      isNull(notices.removedAt),
      eq(notices.scope, scope),
    ];

    if (scope === NoticeScope.CohortTrack && cohortTrackId) {
      conditions.push(eq(notices.cohortTrackId, cohortTrackId));
    } else if (scope === NoticeScope.Cohort && cohortId) {
      conditions.push(eq(notices.cohortId, cohortId));
    }

    const [{ total }] = await tx
      .select({ total: count() })
      .from(notices)
      .where(and(...conditions));

    return total;
  }
}
