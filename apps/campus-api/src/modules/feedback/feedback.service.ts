import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isCheckViolation } from '../../infra/database/check-violation.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import {
  SystemRole,
  UserStatus,
  hasAdminPowers,
  users,
} from '../users/schema.js';
import type {
  CreateFeedbackDto,
  FeedbackDto,
  FeedbackListItemDto,
  FeedbackReceiptDto,
  ListFeedbackQueryDto,
} from './dto/feedback.dto.js';
import {
  FeedbackInvalidArgumentException,
  FeedbackNotFoundException,
  FeedbackRateLimitedException,
} from './feedback.exceptions.js';
import {
  FEEDBACK_USER_AGENT_MAX_LENGTH,
  FeedbackStatus,
  FeedbackType,
  feedback,
} from './schema.js';

/**
 * How much one account may send in an hour. Counted from what is saved, not
 * held in memory: the API runs more than one process and sleeps between
 * requests, and a count that forgot would be no limit.
 */
export const FEEDBACK_MAX_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

const submitter = alias(users, 'submitter');
const reported = alias(users, 'reported');
const resolver = alias(users, 'resolver');

/** The three things an admin is shown of anybody a piece of feedback names. */
const person = <
  T extends { id: unknown; email: unknown; displayName: unknown },
>(
  table: T,
): Pick<T, 'id' | 'email' | 'displayName'> => ({
  id: table.id,
  email: table.email,
  displayName: table.displayName,
});

const listColumns = {
  id: feedback.id,
  type: feedback.type,
  title: feedback.title,
  about: feedback.about,
  status: feedback.status,
  createdAt: feedback.createdAt,
  submittedBy: person(submitter),
  reportedUser: person(reported),
};

@Injectable()
export class FeedbackService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Saves what a member sent. Who sent it comes from their session; the
   * browser that sent it comes from the request; everything else is theirs.
   *
   * A person may only be named by id on a report. The form offers "who or
   * where" on every type, as free text, but an account id is an accusation
   * pointed at somebody, and a bug or an idea has no business making one.
   *
   * A cohort may only be named by somebody in it. It is a hint about where
   * they were, and one they could not have been in is not a hint.
   */
  async create(
    author: AuthenticatedUser,
    dto: CreateFeedbackDto,
    userAgent: string | undefined,
    now: Date = new Date(),
  ): Promise<FeedbackReceiptDto> {
    if (dto.reportedUserId && dto.type !== FeedbackType.Report) {
      throw invalid('reportedUserId', 'reportedUserId is only for a report');
    }

    try {
      return await this.db.transaction(async (tx) => {
        // One send at a time per account. The count below and the insert
        // after it are two statements, and without this a burst of requests
        // would each count before any of them had saved, and all go through.
        // A lock of its own rather than on the users row, which sign-in and
        // refresh hold.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`feedback:${author.id}`}, 0))`,
        );

        const [{ sent }] = await tx
          .select({ sent: count() })
          .from(feedback)
          .where(
            and(
              eq(feedback.submittedBy, author.id),
              gte(feedback.createdAt, new Date(now.getTime() - HOUR_MS)),
            ),
          );
        if (sent >= FEEDBACK_MAX_PER_HOUR) {
          throw new FeedbackRateLimitedException(
            'You have sent a lot of feedback in the last hour. Try again later.',
          );
        }

        // Not asked of an admin. Admins enter any cohort's campus without
        // being in it, as they pass campus-api's sign-in gate and world's
        // cohort check, so any cohort may be where they were. The foreign
        // key still refuses one that does not exist.
        if (dto.cohortId && !hasAdminPowers(author.systemRole)) {
          const [membership] = await tx
            .select({ id: cohortMembers.id })
            .from(cohortMembers)
            .where(
              and(
                eq(cohortMembers.userId, author.id),
                eq(cohortMembers.cohortId, dto.cohortId),
                isLiveMembership(now),
              ),
            )
            .limit(1);
          if (!membership) {
            throw invalid('cohortId', 'cohortId is not a cohort you are in');
          }
        }

        const [row] = await tx
          .insert(feedback)
          .values({
            type: dto.type,
            title: dto.title,
            details: dto.details,
            about: dto.about ?? null,
            reportedUserId: dto.reportedUserId ?? null,
            submittedBy: author.id,
            cohortId: dto.cohortId ?? null,
            // An empty object says nothing; keep the column null for it.
            context:
              dto.context && Object.keys(dto.context).length > 0
                ? { ...dto.context }
                : null,
            userAgent: userAgent?.slice(0, FEEDBACK_USER_AGENT_MAX_LENGTH),
            createdAt: now,
          })
          .returning({
            id: feedback.id,
            type: feedback.type,
            title: feedback.title,
            createdAt: feedback.createdAt,
          });
        return row;
      });
    } catch (err) {
      // What the database will not take because of what was sent is the
      // caller's to correct, not ours to apologise for.
      if (isForeignKeyViolation(err, 'feedback_reported_user_id_users_id_fk')) {
        throw invalid('reportedUserId', 'reportedUserId names no account');
      }
      if (isForeignKeyViolation(err, 'feedback_cohort_id_cohorts_id_fk')) {
        throw invalid('cohortId', 'cohortId names no cohort');
      }
      for (const field of ['title', 'details'] as const) {
        if (isCheckViolation(err, `feedback_${field}_not_blank`)) {
          throw invalid(field, `${field} should not be empty`);
        }
      }
      throw err;
    }
  }

  /**
   * One page for an admin, newest first. A report that names the admin
   * asking is not in it: see `visibleTo`.
   */
  async list(
    viewer: AuthenticatedUser,
    query: ListFeedbackQueryDto,
  ): Promise<PaginatedResponseDto<FeedbackListItemDto>> {
    const filter = and(
      visibleTo(viewer),
      query.type ? eq(feedback.type, query.type) : undefined,
      query.status ? eq(feedback.status, query.status) : undefined,
      query.submittedBy
        ? eq(feedback.submittedBy, query.submittedBy)
        : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select(listColumns)
        .from(feedback)
        .innerJoin(submitter, eq(submitter.id, feedback.submittedBy))
        .leftJoin(reported, eq(reported.id, feedback.reportedUserId))
        .where(filter)
        // Several can land in the same instant; the id keeps pages apart.
        .orderBy(desc(feedback.createdAt), desc(feedback.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(feedback).where(filter),
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
   * One piece of feedback, whole, for an admin. A report that names the
   * admin asking is answered as if it were not there.
   */
  async get(viewer: AuthenticatedUser, id: string): Promise<FeedbackDto> {
    const [row] = await this.db
      .select({
        ...listColumns,
        details: feedback.details,
        cohortId: feedback.cohortId,
        context: feedback.context,
        userAgent: feedback.userAgent,
        resolvedBy: person(resolver),
        resolvedAt: feedback.resolvedAt,
      })
      .from(feedback)
      .innerJoin(submitter, eq(submitter.id, feedback.submittedBy))
      .leftJoin(reported, eq(reported.id, feedback.reportedUserId))
      .leftJoin(resolver, eq(resolver.id, feedback.resolvedBy))
      .where(and(eq(feedback.id, id), visibleTo(viewer)));
    if (!row) {
      throw new FeedbackNotFoundException(`Feedback ${id} not found`, {
        feedbackId: id,
      });
    }
    return row;
  }

  /**
   * Marks a piece of feedback dealt with, or puts it back to open. Setting
   * the status it already has changes nothing and records nothing.
   *
   * The audit entry says who did it and to which, and no more: what the
   * member wrote stays on the feedback.
   */
  async setStatus(
    admin: AuthenticatedUser,
    id: string,
    status: FeedbackStatus,
    correlationId?: string,
    now: Date = new Date(),
  ): Promise<FeedbackDto> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: feedback.status })
        .from(feedback)
        .where(and(eq(feedback.id, id), visibleTo(admin)))
        .for('update');
      if (!current) {
        throw new FeedbackNotFoundException(`Feedback ${id} not found`, {
          feedbackId: id,
        });
      }
      if (current.status === status) {
        return;
      }

      const resolved = status === FeedbackStatus.Resolved;
      await tx
        .update(feedback)
        .set({
          status,
          resolvedBy: resolved ? admin.id : null,
          resolvedAt: resolved ? now : null,
        })
        .where(eq(feedback.id, id));
      await writeAuditEntry(tx, {
        actorUserId: admin.id,
        correlationId,
        action: resolved
          ? AuditAction.FeedbackResolved
          : AuditAction.FeedbackReopened,
        subject: { type: AuditSubjectType.Feedback, id },
        details: {},
      });
    });
    return this.get(admin, id);
  }

  /**
   * Who is told when a report arrives: every account that can read it and
   * can still sign in. Never the account it names — an admin who is reported
   * is not the one to be told, or to read it.
   */
  async reportRecipients(
    reportedUserId: string | undefined,
  ): Promise<string[]> {
    const admins = await this.db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          inArray(users.systemRole, [SystemRole.Admin, SystemRole.SuperAdmin]),
          eq(users.status, UserStatus.Active),
          reportedUserId ? ne(users.id, reportedUserId) : undefined,
        ),
      );
    return admins.map((admin) => admin.email);
  }
}

/**
 * What an admin may see: everything but a report that names them. Somebody
 * who is reported must not be able to read who reported them and what was
 * said, or mark it dealt with. Another admin handles it.
 *
 * Only the account a report names by id can be kept out. A report that
 * names somebody in words alone cannot be matched to anybody.
 */
function visibleTo(viewer: AuthenticatedUser): SQL | undefined {
  return or(
    isNull(feedback.reportedUserId),
    ne(feedback.reportedUserId, viewer.id),
  );
}

function invalid(
  field: string,
  message: string,
): FeedbackInvalidArgumentException {
  return new FeedbackInvalidArgumentException('Request validation failed', {
    fields: { [field]: message },
  });
}
