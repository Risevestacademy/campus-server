import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { NoticeCommentsService } from './notice-comments.service.js';
import { NoticeNotFoundException } from './notices.exceptions.js';
import { NoticesService } from './notices.service.js';
import { NoticeScope, notices } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const db = drizzle(new PGlite(), { schema });
const noticesService = new NoticesService(db as never);
const commentsService = new NoticeCommentsService(db as never);

type Person = AuthenticatedUser & { id: string };
let people: Record<string, Person>;
let noticeRows: Record<string, typeof notices.$inferSelect>;

const asPerson = (row: typeof users.$inferSelect): Person => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});

const list = (viewer: Person, query = {}) =>
  noticesService.list(
    viewer,
    { page: 1, perPage: 100, ...query } as never,
    NOW,
  );

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate comments, audit_log, notices, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [
    memberC1,
    memberC2,
    both,
    professor,
    mentor,
    guest,
    ended,
    expiredGuest,
    outsider,
    admin,
  ] = await db
    .insert(users)
    .values([
      { email: 'c1@campus.local' },
      { email: 'c2@campus.local' },
      { email: 'both@campus.local' },
      { email: 'professor@campus.local' },
      { email: 'mentor@campus.local' },
      { email: 'guest@campus.local' },
      { email: 'ended@campus.local' },
      { email: 'expired@campus.local' },
      { email: 'outsider@campus.local' },
      { email: 'admin@campus.local', systemRole: SystemRole.Admin },
    ])
    .returning();

  const [track1, track2] = await db
    .insert(tracks)
    .values([
      { name: 'Track One', code: 'T1' },
      { name: 'Track Two', code: 'T2' },
    ])
    .returning();
  const [c1, c2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort One', code: 'C1' },
      { name: 'Cohort Two', code: 'C2' },
    ])
    .returning();
  const [c1t1, c1t2, c2t1] = await db
    .insert(cohortTracks)
    .values([
      { cohortId: c1.id, trackId: track1.id },
      { cohortId: c1.id, trackId: track2.id },
      { cohortId: c2.id, trackId: track1.id },
    ])
    .returning();

  await db.insert(cohortMembers).values([
    {
      cohortId: c1.id,
      userId: memberC1.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      cohortTrackId: c1t1.id,
    },
    {
      cohortId: c2.id,
      userId: memberC2.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      cohortTrackId: c2t1.id,
    },
    {
      cohortId: c1.id,
      userId: both.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      cohortTrackId: c1t1.id,
    },
    {
      cohortId: c2.id,
      userId: both.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      cohortTrackId: c2t1.id,
    },
    { cohortId: c1.id, userId: professor.id, role: CohortRole.Professor },
    {
      cohortId: c2.id,
      userId: mentor.id,
      role: CohortRole.Mentor,
      cohortTrackId: c2t1.id,
    },
    {
      cohortId: c1.id,
      userId: guest.id,
      role: CohortRole.Guest,
      accessExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
    {
      cohortId: c1.id,
      userId: ended.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      cohortTrackId: c1t1.id,
      leftAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      cohortId: c1.id,
      userId: expiredGuest.id,
      role: CohortRole.Guest,
      accessExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  ]);

  people = {
    memberC1: asPerson(memberC1),
    memberC2: asPerson(memberC2),
    both: asPerson(both),
    professor: asPerson(professor),
    mentor: asPerson(mentor),
    guest: asPerson(guest),
    ended: asPerson(ended),
    expiredGuest: asPerson(expiredGuest),
    outsider: asPerson(outsider),
    admin: asPerson(admin),
  };

  const created = await db
    .insert(notices)
    .values([
      {
        authorId: admin.id,
        scope: NoticeScope.Campus,
        title: 'Campus notice',
        body: 'Everyone',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.Cohort,
        cohortId: c1.id,
        title: 'Cohort one notice',
        body: 'Cohort one',
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.Cohort,
        cohortId: c2.id,
        title: 'Cohort two notice',
        body: 'Cohort two',
        createdAt: new Date('2026-09-03T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.CohortTrack,
        cohortId: c1.id,
        cohortTrackId: c1t1.id,
        title: 'Cohort one track one',
        body: 'C1 T1',
        createdAt: new Date('2026-09-04T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.CohortTrack,
        cohortId: c1.id,
        cohortTrackId: c1t2.id,
        title: 'Cohort one track two',
        body: 'C1 T2',
        createdAt: new Date('2026-09-05T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.CohortTrack,
        cohortId: c2.id,
        cohortTrackId: c2t1.id,
        title: 'Cohort two track one',
        body: 'C2 T1',
        createdAt: new Date('2026-09-06T00:00:00.000Z'),
      },
    ])
    .returning();

  noticeRows = {
    campus: created[0],
    c1: created[1],
    c2: created[2],
    c1t1: created[3],
    c1t2: created[4],
    c2t1: created[5],
  };
});

const matrix = [
  [
    'a member of one cohort',
    'memberC1',
    ['Campus notice', 'Cohort one notice', 'Cohort one track one'],
  ],
  [
    'a member of another cohort',
    'memberC2',
    ['Campus notice', 'Cohort two notice', 'Cohort two track one'],
  ],
  [
    'a member of two cohorts',
    'both',
    [
      'Campus notice',
      'Cohort one notice',
      'Cohort two notice',
      'Cohort one track one',
      'Cohort two track one',
    ],
  ],
  [
    'a professor without a track',
    'professor',
    ['Campus notice', 'Cohort one notice'],
  ],
  [
    'a mentor on a track',
    'mentor',
    ['Campus notice', 'Cohort two notice', 'Cohort two track one'],
  ],
  ['a guest', 'guest', ['Campus notice', 'Cohort one notice']],
  ['a member who left', 'ended', []],
  ['a guest whose visit ended', 'expiredGuest', []],
  ['somebody with no membership', 'outsider', []],
  [
    'an admin',
    'admin',
    [
      'Campus notice',
      'Cohort one notice',
      'Cohort two notice',
      'Cohort one track one',
      'Cohort one track two',
      'Cohort two track one',
    ],
  ],
] as const;

describe('notice visibility', () => {
  it.each(matrix)(
    '%s gets exactly their list, and the comment routes agree',
    async (_label, key, expected) => {
      const viewer = people[key];
      const page = await list(viewer);

      expect(page.items.map((item) => item.title).sort()).toEqual(
        [...expected].sort(),
      );
      expect(page.meta.total).toBe(expected.length);

      const hidden = Object.values(noticeRows).find(
        (notice) => !expected.includes(notice.title as never),
      );
      const target = hidden ?? noticeRows.campus;

      if (hidden) {
        await expect(
          commentsService.list(
            viewer,
            hidden.id,
            { page: 1, perPage: 20 } as never,
            NOW,
          ),
        ).rejects.toBeInstanceOf(NoticeNotFoundException);
        await expect(
          commentsService.add(
            viewer,
            hidden.id,
            { body: 'not allowed' },
            { actorUserId: viewer.id },
            NOW,
          ),
        ).rejects.toBeInstanceOf(NoticeNotFoundException);
      } else {
        await expect(
          commentsService.list(
            viewer,
            target.id,
            { page: 1, perPage: 20 } as never,
            NOW,
          ),
        ).resolves.toMatchObject({ meta: { total: 0 } });
      }
    },
  );

  it('counts only visible notices, never the hidden ones', async () => {
    const before = await list(people.memberC1);

    await db.insert(notices).values({
      authorId: people.admin.id,
      scope: NoticeScope.Cohort,
      cohortId: noticeRows.c2.cohortId as string,
      title: 'Hidden from C1',
      body: 'C2 only',
    });

    const after = await list(people.memberC1);
    expect(after.meta.total).toBe(before.meta.total);
    expect(after.items.map((item) => item.title)).not.toContain(
      'Hidden from C1',
    );
  });
});

describe('ordering, paging and filters', () => {
  it('puts pinned notices first across the whole result, then newest, then id', async () => {
    await db.execute(sql`truncate notices cascade`);

    const same = new Date('2026-09-10T00:00:00.000Z');
    const rows = await db
      .insert(notices)
      .values([
        {
          authorId: people.admin.id,
          scope: NoticeScope.Campus,
          title: 'Plain older',
          body: 'x',
          createdAt: new Date('2026-09-09T00:00:00.000Z'),
        },
        {
          authorId: people.admin.id,
          scope: NoticeScope.Campus,
          title: 'Pinned old',
          body: 'x',
          pinned: true,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          authorId: people.admin.id,
          scope: NoticeScope.Campus,
          title: 'Plain same A',
          body: 'x',
          createdAt: same,
        },
        {
          authorId: people.admin.id,
          scope: NoticeScope.Campus,
          title: 'Plain same B',
          body: 'x',
          createdAt: same,
        },
        {
          authorId: people.admin.id,
          scope: NoticeScope.Campus,
          title: 'Pinned new',
          body: 'x',
          pinned: true,
          createdAt: new Date('2026-09-11T00:00:00.000Z'),
        },
      ])
      .returning();

    const page = await list(people.memberC1);
    const expected = [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const byDate = b.createdAt.getTime() - a.createdAt.getTime();
      return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
    });

    expect(page.items.map((item) => item.id)).toEqual(
      expected.map((row) => row.id),
    );
  });

  it('walks several pages with no repeats or gaps, including equal created_at', async () => {
    await db.execute(sql`truncate notices cascade`);
    const same = new Date('2026-09-10T00:00:00.000Z');
    await db.insert(notices).values(
      Array.from({ length: 7 }, (_, i) => ({
        authorId: people.admin.id,
        scope: NoticeScope.Campus,
        title: `Notice ${i}`,
        body: 'x',
        createdAt: i < 4 ? same : new Date(2026, 8, 11, 0, i),
      })),
    );

    const walk = async (): Promise<string[]> => {
      const seen: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const result = await noticesService.list(
          people.memberC1,
          { page, perPage: 2 } as never,
          NOW,
        );
        seen.push(...result.items.map((item) => item.id));
      }
      return seen;
    };

    const first = await walk();
    expect(new Set(first).size).toBe(first.length);
    expect(first).toHaveLength(7);

    // Created between page 1 and page 2 of the walk above, so it lands at the
    // top; a fresh walk still covers every page without repeats or gaps.
    await db.insert(notices).values({
      authorId: people.admin.id,
      scope: NoticeScope.Campus,
      title: 'Created between pages',
      body: 'x',
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
    });

    const second = await walk();
    expect(new Set(second).size).toBe(second.length);
    const all = await db.select({ id: notices.id }).from(notices);
    expect(new Set(second).size).toBe(all.length);
  });

  it('never shows a pinned notice outside the viewer scope', async () => {
    await db
      .update(notices)
      .set({ pinned: true })
      .where(eq(notices.id, noticeRows.c1t2.id));

    const page = await list(people.memberC1);
    expect(page.items.map((item) => item.id)).not.toContain(noticeRows.c1t2.id);
    expect(page.meta.total).toBe(3);
  });

  it('narrows by scope and cohort without ever widening', async () => {
    const byScope = await list(people.memberC1, {
      scope: NoticeScope.Cohort,
    });
    expect(byScope.items.map((item) => item.id)).toEqual([noticeRows.c1.id]);

    const byCohort = await list(people.memberC1, {
      cohortId: noticeRows.c2.cohortId,
    });
    expect(byCohort.items).toEqual([]);
    expect(byCohort.meta.total).toBe(0);

    const both = await list(people.memberC1, {
      scope: NoticeScope.CohortTrack,
      cohortId: noticeRows.c1.cohortId,
    });
    expect(both.items.map((item) => item.id)).toEqual([noticeRows.c1t1.id]);
  });
});
