import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
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
import { assertNoticeVisible } from './notice-visibility.js';

/** How many comments one client may add in the window below. */
export const COMMENT_RATE_LIMIT = 30;
export const COMMENT_RATE_WINDOW_MS = 60_000;

const commentColumns = {
  id: comments.id,
  authorId: comments.authorId,
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
    await assertNoticeVisible(this.db, viewer, noticeId, now);

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
      items: rows,
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
   *
   * The share lock is held until commit. A concurrent remove, update or pin
   * takes `FOR UPDATE` on the same notice, so it waits and the comment never
   * lands against a notice that moved underneath it. The visibility check is
   * repeated after the insert as well: if the notice is gone by then the
   * insert rolls back with the transaction rather than leaving a comment
   * behind.
   */
  async add(
    viewer: AuthenticatedUser,
    noticeId: string,
    dto: CreateNoticeCommentDto,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<NoticeCommentDto> {
    return this.db.transaction(async (tx) => {
      await assertNoticeVisible(tx, viewer, noticeId, now, true);

      const [row] = await tx
        .insert(comments)
        .values({
          authorId: viewer.id,
          targetType: CommentTargetType.Notice,
          targetId: noticeId,
          body: dto.body,
        })
        .returning(commentColumns);

      await assertNoticeVisible(tx, viewer, noticeId, now);

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.CommentCreated,
        subject: { type: AuditSubjectType.Comment, id: row.id },
        details: { noticeId },
      });

      return row;
    });
  }
}
