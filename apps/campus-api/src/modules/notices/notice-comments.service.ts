import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import type { PaginationQueryDto } from '../../shared/dto/pagination-query.dto.js';
import { type AuditContext, writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { CommentTargetType, comments } from '../comments/schema.js';
import type {
  CreateNoticeCommentDto,
  NoticeCommentDto,
} from './dto/notice-comment.dto.js';
import { NoticeNotFoundException } from './notices.exceptions.js';
import { noticeVisibleTo } from './notice-visibility.js';
import { notices } from './schema.js';

/** How many comments one client may add in the window below. */
export const COMMENT_RATE_LIMIT = 30;
export const COMMENT_RATE_WINDOW_MS = 60_000;

const commentColumns = {
  id: comments.id,
  authorId: comments.authorId,
  targetType: comments.targetType,
  targetId: comments.targetId,
  body: comments.body,
  createdAt: comments.createdAt,
};

/** Comments on one notice, for members who can see it. */
@Injectable()
export class NoticeCommentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One page of a notice's comments, oldest first, id breaking ties on the
   * same instant. The notice is resolved through the shared visibility rule,
   * so a comment list is never a way around the wall.
   */
  async list(
    viewer: AuthenticatedUser,
    noticeId: string,
    query: PaginationQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResponseDto<NoticeCommentDto>> {
    await this.assertVisible(this.db, viewer, noticeId, now);

    const filter = and(
      eq(comments.targetType, CommentTargetType.Notice),
      eq(comments.targetId, noticeId),
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select(commentColumns)
        .from(comments)
        .where(filter)
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(comments).where(filter),
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
   * Adds a comment from the caller, after resolving the notice through the
   * same visibility rule under a shared row lock. The comment and its audit
   * entry commit together or not at all, and nothing is written on a refusal.
   */
  async add(
    viewer: AuthenticatedUser,
    noticeId: string,
    dto: CreateNoticeCommentDto,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<NoticeCommentDto> {
    return this.db.transaction(async (tx) => {
      await this.assertVisible(tx, viewer, noticeId, now, true);

      const [row] = await tx
        .insert(comments)
        .values({
          authorId: viewer.id,
          targetType: CommentTargetType.Notice,
          targetId: noticeId,
          body: dto.body,
        })
        .returning(commentColumns);

      // The row lock stops another transaction removing or re-scoping the
      // notice while this one runs. Re-check after the insert as well, so a
      // notice that somehow moved is caught before commit and the comment
      // rolls back with it rather than being left behind.
      await this.assertVisible(tx, viewer, noticeId, now);

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.CommentCreated,
        subject: { type: AuditSubjectType.Comment, id: row.id },
        details: { noticeId },
      });

      return toDto(row);
    });
  }

  private async assertVisible(
    executor: DbExecutor,
    viewer: AuthenticatedUser,
    noticeId: string,
    now: Date,
    lock = false,
  ): Promise<void> {
    const condition: SQL<unknown> = noticeVisibleTo(
      executor,
      viewer,
      noticeId,
      now,
    );
    const select = executor
      .select({ id: notices.id })
      .from(notices)
      .where(condition)
      .limit(1);
    const [row] = lock ? await select.for('share') : await select;

    if (!row) {
      throw new NoticeNotFoundException(`Notice ${noticeId} not found`, {
        noticeId,
      });
    }
  }
}

function toDto(
  row: Omit<NoticeCommentDto, 'targetType'> & { targetType: string },
): NoticeCommentDto {
  return {
    ...row,
    targetType: row.targetType as CommentTargetType,
  };
}
