import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, auditLog } from '../audit/schema.js';
import type { NotificationPush } from '../notifications/notification-push.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SystemRole, users } from '../users/schema.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import { NoticesService } from './notices.service.js';
import { NoticeScope, notices } from './schema.js';

const noPush = { send: async () => undefined } as unknown as NotificationPush;

type Pg = ReturnType<typeof connectRealPostgres>;

const asPerson = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});

const wait = (ms: number) =>
  new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms));

/**
 * PGlite serves one connection, so the forced test in the db spec can prove
 * the re-check and rollback but not that the locks really conflict. These run
 * on a real PostgreSQL, where two transactions overlap.
 *
 * They are skipped without CAMPUS_TEST_DATABASE_URL; CI sets it.
 */
describe.skipIf(!REAL_POSTGRES_URL)('notice comments, real row locks', () => {
  let pg: Pg;
  let comments: NoticeCommentsService;
  let noticesService: NoticesService;
  let admin: AuthenticatedUser;

  beforeAll(async () => {
    pg = connectRealPostgres();
    comments = new NoticeCommentsService(pg.db as never);
    noticesService = new NoticesService(
      pg.db as never,
      new NotificationsService(pg.db as never),
      noPush,
    );
    const [row] = await pg.db
      .insert(users)
      .values({
        email: `locks-${unique()}@campus.local`,
        systemRole: SystemRole.Admin,
      })
      .returning();
    admin = asPerson(row);
  });

  afterAll(async () => {
    await pg.close();
  });

  const notice = async (): Promise<string> => {
    const [row] = await pg.db
      .insert(notices)
      .values({
        authorId: admin.id,
        scope: NoticeScope.Campus,
        title: `Lock notice ${unique()}`,
        body: 'For the lock test',
      })
      .returning({ id: notices.id });
    return row.id;
  };

  it('add() waits for an exclusive lock on the notice, then commits', async () => {
    const noticeId = await notice();
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const locker = pg.db.transaction(async (tx) => {
      await tx
        .select({ id: notices.id })
        .from(notices)
        .where(eq(notices.id, noticeId))
        .for('update');
      locked();
      await releasePromise;
    });
    await lockedPromise;

    const add = comments.add(
      admin,
      noticeId,
      { body: 'A comment' },
      { actorUserId: admin.id },
    );

    // If add() did not take a lock, it would commit while the row is held
    // exclusively. It must still be pending.
    await expect(Promise.race([add, wait(150)])).resolves.toBe('pending');

    release();
    await locker;
    const comment = await add;
    expect(comment.body).toBe('A comment');

    const [stored] = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, comment.id));
    expect(stored).toMatchObject({
      actorUserId: admin.id,
      action: AuditAction.CommentCreated,
      subjectType: 'comment',
      details: { noticeId },
    });
  });

  it('remove() waits for a shared lock on the notice, then removes it', async () => {
    const noticeId = await notice();
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const locker = pg.db.transaction(async (tx) => {
      await tx
        .select({ id: notices.id })
        .from(notices)
        .where(eq(notices.id, noticeId))
        .for('share');
      locked();
      await releasePromise;
    });
    await lockedPromise;

    const remove = noticesService.remove(noticeId, admin, {
      actorUserId: admin.id,
    });

    await expect(Promise.race([remove, wait(150)])).resolves.toBe('pending');

    release();
    await locker;
    await expect(remove).resolves.toBeUndefined();

    const [row] = await pg.db
      .select({ removedAt: notices.removedAt })
      .from(notices)
      .where(eq(notices.id, noticeId));
    expect(row.removedAt).toBeInstanceOf(Date);
  });
});
