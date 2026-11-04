import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import type { ListNoticesQueryDto } from './dto/list-notices.dto.js';
import type { NoticeResponseDto } from './dto/notice-response.dto.js';
import { noticesVisibleTo } from './notice-visibility.js';
import { NoticeScope, notices } from './schema.js';

const noticeColumns = {
  id: notices.id,
  authorId: notices.authorId,
  scope: notices.scope,
  cohortId: notices.cohortId,
  cohortTrackId: notices.cohortTrackId,
  title: notices.title,
  body: notices.body,
  pinned: notices.pinned,
  createdAt: notices.createdAt,
  updatedAt: notices.updatedAt,
};

/** The notice wall: the notices the caller can see, newest first. */
@Injectable()
export class NoticesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One page, ordered by pinned first, then newest, then id.
   *
   * The whole result is ordered before it is paged, so a pinned notice does
   * not jump to the top of whichever page it happens to land on, and the id
   * tie-break keeps a page boundary from repeating or dropping a row when
   * several notices share a created_at.
   *
   * The page query and its count share one `filter`, including the visibility
   * predicate, so a notice the member may not see cannot change `total`.
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
}
