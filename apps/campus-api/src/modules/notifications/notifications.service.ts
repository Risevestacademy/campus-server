import { Inject, Injectable } from '@nestjs/common';
import { type SQL, and, eq, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import { NoticeScope, type Notice } from '../notices/schema.js';
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

  /** Every live member in the notice's scope, in one statement. */
  async notifyNoticePosted(
    notice: Pick<Notice, 'id' | 'scope' | 'cohortId' | 'cohortTrackId'>,
    executor: DbExecutor = this.db,
    now: Date = new Date(),
  ) {
    const members = and(isLiveMembership(now), scopeFilter(notice));
    await executor.execute(sql`
      insert into ${notifications}
        (${sql.identifier(notifications.recipientId.name)},
         ${sql.identifier(notifications.kind.name)},
         ${sql.identifier(notifications.referenceType.name)},
         ${sql.identifier(notifications.referenceId.name)})
      select distinct ${cohortMembers.userId},
        ${NotificationKind.NoticePosted}::varchar,
        ${NotificationReferenceType.Notice}::varchar,
        ${notice.id}::varchar
      from ${cohortMembers}
      where ${members}
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
