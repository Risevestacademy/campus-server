import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { users } from '../users/schema.js';
import { writeAuditEntry } from './audit-log.js';
import { AuditAction, AuditSubjectType, auditLog } from './schema.js';

/**
 * Append-only is a property of the table, not of the code that writes to
 * it, so it is proven against the engine with the committed migrations
 * applied: what the trigger lets through, and what it refuses.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), { schema: { users, auditLog } });

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';

const write = (correlationId?: string) =>
  writeAuditEntry(db as never, {
    actorUserId: null,
    correlationId,
    action: AuditAction.TrackCreated,
    subject: { type: AuditSubjectType.Track, id: SUBJECT_ID },
    details: { name: 'Software Engineering', code: 'SE' },
  });

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
  await db.execute(sql`truncate audit_log, users cascade`);
});

describe('audit_log', () => {
  it('accepts an insert', async () => {
    await write('corr-1');

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.TrackCreated,
      subjectType: AuditSubjectType.Track,
      subjectId: SUBJECT_ID,
      details: { name: 'Software Engineering', code: 'SE' },
      correlationId: 'corr-1',
    });
  });

  it('refuses an update, and leaves the entry as it was written', async () => {
    await write();

    expect(
      await reason(db.update(auditLog).set({ action: 'something_else' })),
    ).toContain('audit_log is append-only: UPDATE is not allowed');
    const [row] = await db.select().from(auditLog);
    expect(row.action).toBe(AuditAction.TrackCreated);
  });

  it('refuses a delete, and keeps the entry', async () => {
    await write();
    const [row] = await db.select().from(auditLog);

    expect(
      await reason(db.delete(auditLog).where(eq(auditLog.id, row.id))),
    ).toContain('audit_log is append-only: DELETE is not allowed');
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it('refuses an update that would change nothing', async () => {
    await write();

    expect(
      await reason(
        db.update(auditLog).set({ action: AuditAction.TrackCreated }),
      ),
    ).toContain('append-only');
  });

  // The rule protects entries, so a statement that matches none passes.
  it('lets through a delete that matches no entry', async () => {
    expect(await reason(db.delete(auditLog))).toBe('accepted');
  });

  // An entry shares a transaction with the change it records, so a refused
  // edit of the log takes the rest of that transaction down with it.
  it('rolls back the transaction an edit was attempted in', async () => {
    await write();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@campus.local' });
        await tx.delete(auditLog);
      }),
    ).rejects.toThrow();

    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  // The one account-level consequence: somebody who has acted cannot be
  // removed while their entries stand, and now the entries cannot be either.
  it('keeps an account that has written entries from being deleted', async () => {
    const [actor] = await db
      .insert(users)
      .values({ email: 'admin@campus.local' })
      .returning();
    await writeAuditEntry(db as never, {
      actorUserId: actor.id,
      action: AuditAction.TrackCreated,
      subject: { type: AuditSubjectType.Track, id: SUBJECT_ID },
      details: { name: 'Software Engineering', code: 'SE' },
    });

    expect(
      await reason(db.delete(users).where(eq(users.id, actor.id))),
    ).toContain('audit_log_actor_user_id_users_id_fk');
  });
});
