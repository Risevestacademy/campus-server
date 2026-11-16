import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { CommentTargetType, comments } from '../comments/schema.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { assertNoticeVisible } from './notice-visibility.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import { NoticeNotFoundException } from './notices.exceptions.js';
import { NoticeScope, notices } from './schema.js';

vi.mock('../audit/audit-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/audit-log.js')>();
  return { ...actual, writeAuditEntry: vi.fn(actual.writeAuditEntry) };
});

vi.mock('./notice-visibility.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./notice-visibility.js')>();
  return {
    ...actual,
    assertNoticeVisible: vi.fn(actual.assertNoticeVisible),
  };
});

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const MISSING = '00000000-0000-4000-8000-000000000000';

const db = drizzle(new PGlite(), { schema });
const service = new NoticeCommentsService(db as never);

const asPerson = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});

let author: AuthenticatedUser;
let outsider: AuthenticatedUser;
let admin: AuthenticatedUser;
let authorMemberId: string;
let visibleNoticeId: string;
let hiddenNoticeId: string;
let otherNoticeId: string;

const page = { page: 1, perPage: 100 };
const list = (viewer: AuthenticatedUser, noticeId: string, query = page) =>
  service.list(viewer, noticeId, query as never, NOW);
const add = (
  viewer: AuthenticatedUser,
  noticeId: string,
  body = 'A comment',
  correlationId?: string,
) =>
  service.add(
    viewer,
    noticeId,
    { body },
    { actorUserId: viewer.id, correlationId },
    NOW,
  );

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate comments, audit_log, notices, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [authorRow, outsiderRow, adminRow] = await db
    .insert(users)
    .values([
      { email: 'author@campus.local' },
      { email: 'outsider@campus.local' },
      { email: 'admin@campus.local', systemRole: SystemRole.Admin },
    ])
    .returning();
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Track One', code: 'T1' })
    .returning();
  const [c1, c2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort One', code: 'C1' },
      { name: 'Cohort Two', code: 'C2' },
    ])
    .returning();
  const [c1t1, c2t1] = await db
    .insert(cohortTracks)
    .values([
      { cohortId: c1.id, trackId: track.id },
      { cohortId: c2.id, trackId: track.id },
    ])
    .returning();
  const memberships = await db
    .insert(cohortMembers)
    .values([
      {
        cohortId: c1.id,
        userId: authorRow.id,
        role: CohortRole.Student,
        status: StudentStatus.Active,
        cohortTrackId: c1t1.id,
      },
      {
        cohortId: c2.id,
        userId: outsiderRow.id,
        role: CohortRole.Student,
        status: StudentStatus.Active,
        cohortTrackId: c2t1.id,
      },
    ])
    .returning();

  const [visible, hidden, other] = await db
    .insert(notices)
    .values([
      {
        authorId: adminRow.id,
        scope: NoticeScope.Cohort,
        cohortId: c1.id,
        title: 'Visible',
        body: 'Visible body',
      },
      {
        authorId: adminRow.id,
        scope: NoticeScope.Cohort,
        cohortId: c2.id,
        title: 'Hidden',
        body: 'Hidden body',
      },
      {
        authorId: adminRow.id,
        scope: NoticeScope.Cohort,
        cohortId: c1.id,
        title: 'Other',
        body: 'Other body',
      },
    ])
    .returning();

  author = asPerson(authorRow);
  outsider = asPerson(outsiderRow);
  admin = asPerson(adminRow);
  authorMemberId = memberships[0].id;
  visibleNoticeId = visible.id;
  hiddenNoticeId = hidden.id;
  otherNoticeId = other.id;
});

describe('adding a comment', () => {
  it('stores the caller as author, the URL as target, and dates it in the database', async () => {
    const comment = await add(
      author,
      visibleNoticeId,
      'I can help on Friday.',
      'req-1',
    );

    expect(comment).toMatchObject({
      authorId: author.id,
      body: 'I can help on Friday.',
    });
    expect(comment.createdAt).toBeInstanceOf(Date);

    const [stored] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, comment.id));
    expect(stored).toMatchObject({
      id: comment.id,
      authorId: author.id,
      targetType: CommentTargetType.Notice,
      targetId: visibleNoticeId,
      body: 'I can help on Friday.',
    });
    expect(stored.createdAt).toEqual(comment.createdAt);

    const entries = await db.select().from(auditLog);
    expect(entries).toEqual([
      expect.objectContaining({
        actorUserId: author.id,
        action: AuditAction.CommentCreated,
        subjectType: AuditSubjectType.Comment,
        subjectId: comment.id,
        details: { noticeId: visibleNoticeId },
        correlationId: 'req-1',
      }),
    ]);
    expect(JSON.stringify(entries[0].details)).not.toContain(
      'I can help on Friday',
    );
  });

  it('lets an admin comment on a notice no cohort membership reaches', async () => {
    const comment = await add(admin, hiddenNoticeId, 'Admin note');
    expect(comment.authorId).toBe(admin.id);
  });

  it('gives an outsider and a missing notice the same refusal, writing nothing', async () => {
    const errors: unknown[] = [];
    for (const [viewer, noticeId] of [
      [outsider, visibleNoticeId],
      [author, hiddenNoticeId],
      [author, MISSING],
    ] as const) {
      errors.push(
        await list(viewer, noticeId).catch((error: unknown) => error),
      );
      errors.push(
        await add(viewer, noticeId, 'nope').catch((error: unknown) => error),
      );
    }

    for (const error of errors) {
      expect(error).toBeInstanceOf(NoticeNotFoundException);
      expect(error).toMatchObject({
        message: expect.stringMatching(/^Notice .+ not found$/),
        details: { noticeId: expect.any(String) },
      });
    }
    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('rolls back the comment when its audit entry cannot be written', async () => {
    vi.mocked(writeAuditEntry).mockRejectedValueOnce(new Error('audit down'));

    await expect(add(author, visibleNoticeId)).rejects.toThrow('audit down');

    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('rolls back when the notice disappears after the visibility check', async () => {
    const real = vi.mocked(assertNoticeVisible).getMockImplementation();
    expect(real).toBeDefined();

    vi.mocked(assertNoticeVisible).mockImplementationOnce(async (...args) => {
      await real!(...args);
      // The same executor, so the delete is inside the comment's
      // transaction. Using the pool here would wait on the FOR SHARE lock
      // the transaction itself holds.
      const executor = args[0] as typeof db;
      await executor.delete(notices).where(eq(notices.id, args[2]));
    });

    await expect(add(author, visibleNoticeId)).rejects.toBeInstanceOf(
      NoticeNotFoundException,
    );

    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('keeps the old comment but refuses after the author leaves the cohort', async () => {
    const comment = await add(author, visibleNoticeId);

    await db
      .update(cohortMembers)
      .set({ leftAt: NOW })
      .where(eq(cohortMembers.id, authorMemberId));

    await expect(list(author, visibleNoticeId)).rejects.toBeInstanceOf(
      NoticeNotFoundException,
    );
    await expect(add(author, visibleNoticeId)).rejects.toBeInstanceOf(
      NoticeNotFoundException,
    );
    expect(await db.select().from(comments)).toEqual([
      expect.objectContaining({ id: comment.id }),
    ]);
  });

  it('keeps the comment but hides it when the notice is soft-removed', async () => {
    const comment = await add(author, visibleNoticeId);

    await db
      .update(notices)
      .set({ removedAt: NOW })
      .where(eq(notices.id, visibleNoticeId));

    await expect(list(author, visibleNoticeId)).rejects.toBeInstanceOf(
      NoticeNotFoundException,
    );
    await expect(add(author, visibleNoticeId)).rejects.toBeInstanceOf(
      NoticeNotFoundException,
    );
    expect(await db.select().from(comments)).toEqual([
      expect.objectContaining({ id: comment.id }),
    ]);
  });
});

describe('listing comments', () => {
  it('returns oldest first, id breaking ties on the same instant', async () => {
    const at = new Date('2026-09-10T00:00:00.000Z');
    const ids = [
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    await db.insert(comments).values(
      ids.map((id) => ({
        id,
        authorId: author.id,
        targetType: CommentTargetType.Notice,
        targetId: visibleNoticeId,
        body: `body ${id}`,
        createdAt: at,
      })),
    );

    const result = await list(author, visibleNoticeId);

    expect(result.items.map((item) => item.id)).toEqual([...ids].sort());
  });

  it('walks several pages without repeats or gaps, and a comment added between pages does not skip one', async () => {
    for (let i = 0; i < 5; i++) {
      await db.insert(comments).values({
        authorId: author.id,
        targetType: CommentTargetType.Notice,
        targetId: visibleNoticeId,
        body: `comment ${i}`,
        createdAt: new Date(2026, 8, 10, 0, i),
      });
    }

    const first = await list(author, visibleNoticeId, { page: 1, perPage: 2 });
    const seen = first.items.map((item) => item.id);

    await add(author, visibleNoticeId, 'between pages');

    for (let index = 2; index <= 3; index++) {
      const result = await list(author, visibleNoticeId, {
        page: index,
        perPage: 2,
      });
      seen.push(...result.items.map((item) => item.id));
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(6);
  });

  it('never returns another notice’s comments', async () => {
    const mine = await add(author, visibleNoticeId, 'mine');
    const theirs = await db
      .insert(comments)
      .values({
        authorId: admin.id,
        targetType: CommentTargetType.Notice,
        targetId: otherNoticeId,
        body: 'theirs',
      })
      .returning();

    const result = await list(author, visibleNoticeId);

    expect(result.items.map((item) => item.id)).toEqual([mine.id]);
    expect(result.items.map((item) => item.id)).not.toContain(theirs[0].id);
    expect(result.meta.total).toBe(1);
  });

  it('returns an empty page for a visible notice with no comments', async () => {
    const result = await list(author, visibleNoticeId);
    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
  });
});
