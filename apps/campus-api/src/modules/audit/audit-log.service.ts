import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lt } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import type {
  AuditLogEntryDto,
  ListAuditLogQueryDto,
} from './dto/list-audit-log.dto.js';
import { auditLog } from './schema.js';

/**
 * The admin's read of the audit log. Writing stays with writeAuditEntry,
 * which takes the caller's transaction; this only ever reads.
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One page of entries, newest first. Entries from one transaction share
   * a `created_at`, so the id breaks the tie and keeps pages from
   * overlapping.
   */
  async list(
    query: ListAuditLogQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogEntryDto>> {
    const filter = and(
      query.action ? eq(auditLog.action, query.action) : undefined,
      query.actorUserId
        ? eq(auditLog.actorUserId, query.actorUserId)
        : undefined,
      query.subjectType
        ? eq(auditLog.subjectType, query.subjectType)
        : undefined,
      query.subjectId ? eq(auditLog.subjectId, query.subjectId) : undefined,
      query.from ? gte(auditLog.createdAt, new Date(query.from)) : undefined,
      query.to ? lt(auditLog.createdAt, new Date(query.to)) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: auditLog.id,
          actorUserId: auditLog.actorUserId,
          action: auditLog.action,
          subjectType: auditLog.subjectType,
          subjectId: auditLog.subjectId,
          details: auditLog.details,
          correlationId: auditLog.correlationId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(filter)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(auditLog).where(filter),
    ]);

    return {
      items: rows.map((row) => ({
        ...row,
        details: row.details as Record<string, unknown> | null,
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
