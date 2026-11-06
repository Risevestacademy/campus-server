import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import {
  AUDIT_LOG_APPEND_ONLY_TRIGGER,
  AuditAction,
  AuditSubjectType,
  auditLog,
} from '../audit/schema.js';
import { notifications } from '../notifications/schema.js';
import { users } from '../users/schema.js';
import { RetentionService, RetentionTable } from './retention.service.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, auditLog, notifications },
});
const config = {
  NOTIFICATION_RETENTION_DAYS: 90,
  AUDIT_LOG_RETENTION_DAYS: 365,
};
const logger = { setContext: vi.fn(), info: vi.fn() };
const service = new RetentionService(
  db as never,
  config as never,
  logger as never,
);

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

let adminId: string;

async function notification(createdDaysAgo: number, read: boolean) {
  const [row] = await db
    .insert(notifications)
    .values({
      recipientId: adminId,
      kind: 'notice_posted',
      referenceType: 'notice',
      referenceId: randomUUID(),
      createdAt: daysAgo(createdDaysAgo),
      readAt: read ? daysAgo(createdDaysAgo) : null,
    })
    .returning();
  return row.id;
}

async function auditEntry(createdDaysAgo: number) {
  const [row] = await db
    .insert(auditLog)
    .values({
      actorUserId: null,
      action: AuditAction.TrackCreated,
      subjectType: AuditSubjectType.Track,
      subjectId: randomUUID(),
      details: { name: 'Software Engineering', code: 'SE' },
      createdAt: daysAgo(createdDaysAgo),
    })
    .returning();
  return row.id;
}

const notificationIds = async () =>
  (await db.select({ id: notifications.id }).from(notifications))
    .map((row) => row.id)
    .sort();

const entriesOf = (action: AuditAction) =>
  db.select().from(auditLog).where(eq(auditLog.action, action));

/** 'O' is enabled; 'D' disabled. */
async function triggerState(): Promise<string> {
  const { rows } = await db.execute<{ tgenabled: string }>(
    sql`select tgenabled from pg_trigger where tgname = ${AUDIT_LOG_APPEND_ONLY_TRIGGER}`,
  );
  return rows[0].tgenabled;
}

/** The Postgres error under drizzle's wrapper, where the message lives. */
const reason = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    return String((cause as { message?: unknown }).message ?? cause);
  }
  return 'accepted';
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, notifications, users cascade`);
  logger.info.mockClear();
  const [admin] = await db
    .insert(users)
    .values({ email: 'root@campus.local' })
    .returning();
  adminId = admin.id;
});

describe('RetentionService', () => {
  it('deletes only read notifications and audit entries past their period', async () => {
    await notification(100, true);
    await notification(400, true);
    const recentRead = await notification(89, true);
    const oldUnread = await notification(100, false);
    await auditEntry(366);
    await auditEntry(1000);
    const recentEntry = await auditEntry(364);

    const results = await service.sweep({ actorUserId: adminId });

    expect(results).toEqual([
      expect.objectContaining({
        table: RetentionTable.Notifications,
        deleted: 2,
        retentionDays: 90,
      }),
      expect.objectContaining({
        table: RetentionTable.AuditLog,
        deleted: 2,
        retentionDays: 365,
      }),
    ]);
    expect(await notificationIds()).toEqual([recentRead, oldUnread].sort());
    const kept = await entriesOf(AuditAction.TrackCreated);
    expect(kept.map((row) => row.id)).toEqual([recentEntry]);
  });

  it('keeps unread notifications however old they are', async () => {
    const ancient = await notification(5 * 365, false);
    const old = await notification(120, false);

    const result = await service.sweepNotifications({
      actorUserId: adminId,
      retentionDays: 30,
    });

    expect(result.deleted).toBe(0);
    expect(await notificationIds()).toEqual([ancient, old].sort());
  });

  it('leaves the append-only trigger on after a sweep', async () => {
    await auditEntry(400);
    const kept = await auditEntry(10);

    await service.sweepAuditLog({ actorUserId: adminId });

    expect(await triggerState()).toBe('O');
    expect(
      await reason(db.delete(auditLog).where(eq(auditLog.id, kept))),
    ).toContain('audit_log is append-only: DELETE is not allowed');
    expect(await entriesOf(AuditAction.TrackCreated)).toHaveLength(1);
  });

  it('records each sweep in the audit log, where the trigger protects it', async () => {
    await auditEntry(400);

    await service.sweep({ actorUserId: adminId, correlationId: 'corr-1' });

    const entries = await entriesOf(AuditAction.RetentionSwept);
    expect(
      entries
        .map((entry) => entry.details)
        .sort((a, b) =>
          String((a as { table: string }).table).localeCompare(
            String((b as { table: string }).table),
          ),
        ),
    ).toEqual([
      expect.objectContaining({ table: 'audit_log', deleted: 1 }),
      expect.objectContaining({ table: 'notifications', deleted: 0 }),
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actorUserId: adminId,
        correlationId: 'corr-1',
        subjectType: null,
        subjectId: null,
      });
    }
    expect(
      await reason(db.delete(auditLog).where(eq(auditLog.id, entries[0].id))),
    ).toContain('append-only');
  });

  it('logs the table, the count and the cutoff', async () => {
    await notification(100, true);

    const result = await service.sweepNotifications({ actorUserId: adminId });

    expect(logger.info).toHaveBeenCalledWith(
      {
        table: 'notifications',
        deleted: 1,
        cutoff: result.cutoff.toISOString(),
        retentionDays: 90,
      },
      'retention sweep',
    );
  });

  // The actor is a foreign key, so an unknown one fails the sweep's own
  // entry: the last statement, after the delete and the re-enable.
  it('rolls the whole sweep back when any part fails, trigger included', async () => {
    const old = await auditEntry(400);

    await expect(
      service.sweepAuditLog({ actorUserId: randomUUID() }),
    ).rejects.toThrow();

    expect(await triggerState()).toBe('O');
    expect(
      (await entriesOf(AuditAction.TrackCreated)).map((r) => r.id),
    ).toEqual([old]);
    expect(
      await reason(db.delete(auditLog).where(eq(auditLog.id, old))),
    ).toContain('append-only');
  });

  it('applies a one-off period to the named table only', async () => {
    await notification(40, true);
    await auditEntry(40);

    const results = await service.sweep({
      actorUserId: adminId,
      table: RetentionTable.Notifications,
      retentionDays: 30,
    });

    expect(results).toEqual([
      expect.objectContaining({ table: 'notifications', deleted: 1 }),
    ]);
    expect(await entriesOf(AuditAction.TrackCreated)).toHaveLength(1);
  });

  describe('the 30-day floor', () => {
    it('refuses a shorter period, and deletes nothing', async () => {
      await notification(20, true);
      await auditEntry(20);

      await expect(
        service.sweepNotifications({ actorUserId: adminId, retentionDays: 29 }),
      ).rejects.toThrow(InvalidArgumentException);
      await expect(
        service.sweepAuditLog({ actorUserId: adminId, retentionDays: 1 }),
      ).rejects.toThrow(InvalidArgumentException);

      expect(await notificationIds()).toHaveLength(1);
      expect(await entriesOf(AuditAction.TrackCreated)).toHaveLength(1);
      expect(await entriesOf(AuditAction.RetentionSwept)).toHaveLength(0);
    });

    it('refuses a custom period with no table to apply it to', async () => {
      await expect(
        service.sweep({ actorUserId: adminId, retentionDays: 60 }),
      ).rejects.toThrow(InvalidArgumentException);
    });
  });
});
