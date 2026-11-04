import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

import * as schema from '../../infra/database/schema/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { SystemRole, users } from '../users/schema.js';
import { CommentTargetType, comments } from '../comments/schema.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import { NoticeNotFoundException } from './notices.exceptions.js';
import { NoticeScope, notices } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const MISSING = '00000000-0000-4000-8000-000000000000';

vi.mock('../audit/audit-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/audit-log.js')>();
  return { ...actual, writeAuditEntry: vi.fn(actual.writeAuditEntry) };
});

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
  await db.insert(cohortMembers).values([
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
  ]);

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
  visibleNoticeId = visible.id;
  hiddenNoticeId = hidden.id;
  otherNoticeId = other.id;
});

describe('adding a comment', () => {
  it('stores the caller as author, the URL as target, and dates it in the database', async () => {
    const comment = await add(
      author,
      visibleNoticeId,
      '  I can help on Friday.  ',
      'req-1',
    );

    expect(comment).toMatchObject({
      authorId: author.id,
      targetType: CommentTargetType.Notice,
      targetId: visibleNoticeId,
      body: '  I can help on Friday.  ',
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
    const target = service as unknown as {
      assertVisible(
        executor: unknown,
        viewer: AuthenticatedUser,
        noticeId: string,
        now: Date,
        lock?: boolean,
      ): Promise<void>;
    };
    const real = target.assertVisible.bind(target);
    const spy = vi
      .spyOn(target, 'assertVisible')
      .mockImplementationOnce(async (executor, viewer, noticeId, now, lock) => {
        await real(executor, viewer, noticeId, now, lock);
        await (executor as typeof db)
          .delete(notices)
          .where(eq(notices.id, noticeId));
      });

    try {
      await expect(add(author, visibleNoticeId)).rejects.toBeInstanceOf(
        NoticeNotFoundException,
      );
    } finally {
      spy.mockRestore();
    }

    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('keeps the old comment but refuses after the author leaves the cohort', async () => {
    const comment = await add(author, visibleNoticeId);

    await db
      .update(cohortMembers)
      .set({ leftAt: NOW })
      .where(eq(cohortMembers.userId, author.id));

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

  it('walks several pages without repeats or gaps, and a fresh walk survives a new comment', async () => {
    for (let i = 0; i < 5; i++) {
      await db.insert(comments).values({
        authorId: author.id,
        targetType: CommentTargetType.Notice,
        targetId: visibleNoticeId,
        body: `comment ${i}`,
        createdAt: new Date(2026, 8, 10, 0, i),
      });
    }

    const walk = async (): Promise<string[]> => {
      const seen: string[] = [];
      for (let index = 1; index <= 3; index++) {
        const result = await service.list(
          author,
          visibleNoticeId,
          { page: index, perPage: 2 } as never,
          NOW,
        );
        seen.push(...result.items.map((item) => item.id));
      }
      return seen;
    };

    const first = await walk();
    expect(new Set(first).size).toBe(first.length);
    expect(first).toHaveLength(5);

    await add(author, visibleNoticeId, 'between pages');

    const second = await walk();
    expect(new Set(second).size).toBe(second.length);
    expect(second).toHaveLength(6);
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

  it('paginates newest-last and keeps the count on the same filter', async () => {
    const rows = await db
      .insert(comments)
      .values(
        Array.from({ length: 3 }, (_, i) => ({
          authorId: author.id,
          targetType: CommentTargetType.Notice,
          targetId: visibleNoticeId,
          body: `comment ${i}`,
          createdAt: new Date(2026, 8, 10, 0, i),
        })),
      )
      .returning();

    const result = await list(author, visibleNoticeId, {
      page: 1,
      perPage: 2,
    });
    expect(result.meta.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(
      rows
        .slice()
        .sort((a, b) =>
          a.createdAt.getTime() === b.createdAt.getTime()
            ? a.id.localeCompare(b.id)
            : a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .slice(0, 2)
        .map((row) => row.id),
    );
  });
});
