import { Inject, Injectable } from '@nestjs/common';
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG } from '../../infra/config/config.constants.js';
import { MIN_RETENTION_DAYS, type Env } from '../../infra/config/env.js';
import {
  DRIZZLE,
  type Db,
  type Tx,
} from '../../infra/database/database.constants.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import {
  AUDIT_LOG_APPEND_ONLY_TRIGGER,
  AuditAction,
  auditLog,
} from '../audit/schema.js';
import { notifications } from '../notifications/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Long enough to wait for audit writes already in flight; short enough that
 * a sweep stuck behind a long transaction gives up rather than queueing every
 * audit write that arrives after it.
 */
const AUDIT_LOCK_TIMEOUT = '5s';

export enum RetentionTable {
  Notifications = 'notifications',
  AuditLog = 'audit_log',
}

export interface RetentionSweepResult {
  table: RetentionTable;
  deleted: number;
  /** Rows created before this instant were deleted. */
  cutoff: Date;
  retentionDays: number;
}

export interface RetentionSweepOptions {
  /** Who asked: written as the actor of the sweep's audit entry. */
  actorUserId: string | null;
  correlationId?: string;
  /** Overrides the configured period for this one sweep. At least 30. */
  retentionDays?: number;
  now?: Date;
}

/**
 * Deletes rows that have outlived their retention period, one table at a
 * time, each in a transaction of its own that also writes the sweep's audit
 * entry. Nothing calls it on a timer: see this module's README.
 */
@Injectable()
export class RetentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RetentionService.name);
  }

  /**
   * One table, or both, notifications first. A custom period only with a
   * table: 30 days is a reasonable cleanup for notifications and a drastic
   * one for the audit log, so it is never applied to both at once.
   */
  async sweep(
    options: RetentionSweepOptions & { table?: RetentionTable },
  ): Promise<RetentionSweepResult[]> {
    if (options.table === undefined && options.retentionDays !== undefined) {
      throw new InvalidArgumentException(
        'retentionDays needs a table: name the one table to sweep with it',
      );
    }
    const results: RetentionSweepResult[] = [];
    if (options.table !== RetentionTable.AuditLog) {
      results.push(await this.sweepNotifications(options));
    }
    if (options.table !== RetentionTable.Notifications) {
      results.push(await this.sweepAuditLog(options));
    }
    return results;
  }

  /** Read notifications past the period. Unread ones stay at any age. */
  async sweepNotifications(
    options: RetentionSweepOptions,
  ): Promise<RetentionSweepResult> {
    const { retentionDays, cutoff } = this.window(
      options,
      this.config.NOTIFICATION_RETENTION_DAYS,
    );

    const deleted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(notifications)
        .where(
          and(
            lt(notifications.createdAt, cutoff),
            isNotNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });
      await this.recordSweep(tx, options, {
        table: RetentionTable.Notifications,
        retentionDays,
        cutoff,
        deleted: rows.length,
      });
      return rows.length;
    });

    return this.logged({
      table: RetentionTable.Notifications,
      deleted,
      cutoff,
      retentionDays,
    });
  }

  /**
   * Audit entries past the period. The append-only trigger refuses every
   * DELETE, so it is lifted for this transaction alone: ALTER TABLE is
   * transactional, and the lock it takes keeps everyone else off the table
   * until commit, so no other transaction ever sees it disabled. If anything
   * fails the rollback undoes the disable along with the delete.
   *
   * The sweep's own entry is written after the trigger is back on, so it is
   * protected from the moment it commits.
   */
  async sweepAuditLog(
    options: RetentionSweepOptions,
  ): Promise<RetentionSweepResult> {
    const { retentionDays, cutoff } = this.window(
      options,
      this.config.AUDIT_LOG_RETENTION_DAYS,
    );
    const trigger = sql.identifier(AUDIT_LOG_APPEND_ONLY_TRIGGER);

    const deleted = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`set local lock_timeout = '${AUDIT_LOCK_TIMEOUT}'`),
      );
      await tx.execute(sql`alter table ${auditLog} disable trigger ${trigger}`);
      const rows = await tx
        .delete(auditLog)
        .where(lt(auditLog.createdAt, cutoff))
        .returning({ id: auditLog.id });
      await tx.execute(sql`alter table ${auditLog} enable trigger ${trigger}`);
      await this.recordSweep(tx, options, {
        table: RetentionTable.AuditLog,
        retentionDays,
        cutoff,
        deleted: rows.length,
      });
      return rows.length;
    });

    return this.logged({
      table: RetentionTable.AuditLog,
      deleted,
      cutoff,
      retentionDays,
    });
  }

  private window(
    options: RetentionSweepOptions,
    configured: number,
  ): { retentionDays: number; cutoff: Date } {
    const retentionDays = options.retentionDays ?? configured;
    // The DTO and the Env already refuse this; checked again here because
    // the service can be called without either.
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < MIN_RETENTION_DAYS
    ) {
      throw new InvalidArgumentException(
        `retentionDays must be a whole number of at least ${MIN_RETENTION_DAYS}`,
        { retentionDays },
      );
    }
    const now = options.now ?? new Date();
    return {
      retentionDays,
      cutoff: new Date(now.getTime() - retentionDays * DAY_MS),
    };
  }

  private recordSweep(
    tx: Tx,
    options: RetentionSweepOptions,
    details: RetentionSweepResult,
  ): Promise<void> {
    return writeAuditEntry(tx, {
      actorUserId: options.actorUserId,
      correlationId: options.correlationId,
      action: AuditAction.RetentionSwept,
      subject: null,
      details,
    });
  }

  private logged(result: RetentionSweepResult): RetentionSweepResult {
    this.logger.info(
      {
        table: result.table,
        deleted: result.deleted,
        cutoff: result.cutoff.toISOString(),
        retentionDays: result.retentionDays,
      },
      'retention sweep',
    );
    return result;
  }
}
