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
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import type { NotificationPush } from '../notifications/notification-push.js';
import { NotificationsService } from '../notifications/notifications.service.js';
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
const noPush = { send: async () => undefined } as unknown as NotificationPush;

const db = drizzle(new PGlite(), { schema });
const noticesService = new NoticesService(
  db as never,
  new NotificationsService(db as never),
  noPush,
);
const commentsService = new NoticeCommentsService(db as never);

type Person = AuthenticatedUser & { id: string };

const asPerson = (row: typeof users.$inferSelect): Person => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});

const ALL_TITLES = [
  'Campus',
  'Cohort one',
  'Cohort two',
  'Cohort one track one',
  'Cohort one track two',
  'Cohort two track one',
  'Mentor group',
] as const;

let people: Record<string, Person>;
let noticesByTitle: Record<string, typeof notices.$inferSelect>;
let cohortIds: { c1: string; c2: string };

const list = (viewer: Person, query: Record<string, unknown> = {}) =>
  noticesService.list(
    viewer,
    { page: 1, perPage: 100, ...query } as never,
    NOW,
  );

const listComments = (viewer: Person, noticeId: string) =>
  commentsService.list(
    viewer,
    noticeId,
    { page: 1, perPage: 20 } as never,
    NOW,
  );

const addComment = (viewer: Person, noticeId: string, body = 'A comment') =>
  commentsService.add(
    viewer,
    noticeId,
    { body },
    { actorUserId: viewer.id },
    NOW,
  );

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate comments, audit_log, notices, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [
    memberC1,
    memberC2,
    both,
    professorNoTrack,
    professorOnTrack,
    mentorNoTrack,
    mentorOnTrack,
    guestLive,
    guestOnTrack,
    guestExpired,
    ended,
    outsider,
    admin,
  ] = await db
    .insert(users)
    .values([
      { email: 'c1@campus.local' },
      { email: 'c2@campus.local' },
      { email: 'both@campus.local' },
      { email: 'prof-no-track@campus.local' },
      { email: 'prof-track@campus.local' },
      { email: 'mentor-no-track@campus.local' },
      { email: 'mentor-track@campus.local' },
      { email: 'guest@campus.local' },
      { email: 'guest-track@campus.local' },
      { email: 'guest-expired@campus.local' },
      { email: 'ended@campus.local' },
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

  const memberships = await db
    .insert(cohortMembers)
    .values([
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
      {
        cohortId: c1.id,
        userId: professorNoTrack.id,
        role: CohortRole.Professor,
      },
      {
        cohortId: c1.id,
        userId: professorOnTrack.id,
        role: CohortRole.Professor,
        cohortTrackId: c1t1.id,
      },
      {
        cohortId: c1.id,
        userId: mentorNoTrack.id,
        role: CohortRole.Mentor,
      },
      {
        cohortId: c1.id,
        userId: mentorOnTrack.id,
        role: CohortRole.Mentor,
        cohortTrackId: c1t1.id,
      },
      {
        cohortId: c1.id,
        userId: guestLive.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        cohortId: c1.id,
        userId: guestOnTrack.id,
        role: CohortRole.Guest,
        cohortTrackId: c1t1.id,
        accessExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        cohortId: c1.id,
        userId: guestExpired.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
      },
      {
        cohortId: c1.id,
        userId: ended.id,
        role: CohortRole.Student,
        status: StudentStatus.Active,
        cohortTrackId: c1t1.id,
        leftAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ])
    .returning();

  const memberC1Membership = memberships[0];
  const mentorOnTrackMembership = memberships[7];

  const [group] = await db
    .insert(mentorshipGroups)
    .values({
      cohortId: c1.id,
      mentorMemberId: mentorOnTrackMembership.id,
      name: 'Pod One',
    })
    .returning();
  await db.insert(mentorshipGroupStudents).values({
    mentorshipGroupId: group.id,
    cohortId: c1.id,
    cohortMemberId: memberC1Membership.id,
  });

  const created = await db
    .insert(notices)
    .values([
      {
        authorId: admin.id,
        scope: NoticeScope.Campus,
        title: 'Campus',
        body: 'Everyone',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.Cohort,
        cohortId: c1.id,
        title: 'Cohort one',
        body: 'Cohort one',
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.Cohort,
        cohortId: c2.id,
        title: 'Cohort two',
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
      {
        authorId: admin.id,
        scope: NoticeScope.MentorshipGroup,
        cohortId: c1.id,
        mentorshipGroupId: group.id,
        title: 'Mentor group',
        body: 'The pod',
        createdAt: new Date('2026-09-07T00:00:00.000Z'),
      },
      {
        authorId: admin.id,
        scope: NoticeScope.Cohort,
        cohortId: c1.id,
        title: 'Removed cohort one',
        body: 'Gone',
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        removedAt: new Date('2026-09-09T00:00:00.000Z'),
      },
    ])
    .returning();

  people = {
    memberC1: asPerson(memberC1),
    memberC2: asPerson(memberC2),
    both: asPerson(both),
    professorNoTrack: asPerson(professorNoTrack),
    professorOnTrack: asPerson(professorOnTrack),
    mentorNoTrack: asPerson(mentorNoTrack),
    mentorOnTrack: asPerson(mentorOnTrack),
    guestLive: asPerson(guestLive),
    guestOnTrack: asPerson(guestOnTrack),
    guestExpired: asPerson(guestExpired),
    ended: asPerson(ended),
    outsider: asPerson(outsider),
    admin: asPerson(admin),
  };
  noticesByTitle = Object.fromEntries(created.map((row) => [row.title, row]));
  cohortIds = { c1: c1.id, c2: c2.id };
});

const matrix: ReadonlyArray<
  readonly [string, keyof typeof people, readonly string[]]
> = [
  [
    'a student of one cohort, also in its pod',
    'memberC1',
    ['Campus', 'Cohort one', 'Cohort one track one', 'Mentor group'],
  ],
  [
    'a student of another cohort',
    'memberC2',
    ['Campus', 'Cohort two', 'Cohort two track one'],
  ],
  [
    'a member of two cohorts',
    'both',
    [
      'Campus',
      'Cohort one',
      'Cohort two',
      'Cohort one track one',
      'Cohort two track one',
    ],
  ],
  ['a professor without a track', 'professorNoTrack', ['Campus', 'Cohort one']],
  [
    'a professor on a track',
    'professorOnTrack',
    ['Campus', 'Cohort one', 'Cohort one track one'],
  ],
  ['a mentor without a track', 'mentorNoTrack', ['Campus', 'Cohort one']],
  [
    'a mentor on a track, leading a pod',
    'mentorOnTrack',
    ['Campus', 'Cohort one', 'Cohort one track one', 'Mentor group'],
  ],
  ['a live guest', 'guestLive', ['Campus', 'Cohort one']],
  [
    'a live guest on a track',
    'guestOnTrack',
    ['Campus', 'Cohort one', 'Cohort one track one'],
  ],
  ['a guest whose visit ended', 'guestExpired', []],
  ['a member who left', 'ended', []],
  ['somebody with no membership', 'outsider', []],
  ['an admin', 'admin', ALL_TITLES],
];

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

      const hidden = ALL_TITLES.filter((title) => !expected.includes(title));
      if (hidden.length > 0) {
        // Every hidden notice, not just the first: the cohort, track and
        // group rules must all hold on both comment routes.
        for (const title of hidden) {
          const notice = noticesByTitle[title];
          await expect(listComments(viewer, notice.id)).rejects.toBeInstanceOf(
            NoticeNotFoundException,
          );
          await expect(
            addComment(viewer, notice.id, 'not allowed'),
          ).rejects.toBeInstanceOf(NoticeNotFoundException);
        }
      } else {
        const notice = noticesByTitle.Campus;
        await expect(listComments(viewer, notice.id)).resolves.toMatchObject({
          meta: { total: 0 },
        });
        const comment = await addComment(viewer, notice.id, 'hello');
        expect(comment.authorId).toBe(viewer.id);
      }
    },
  );

  it('never lists a removed notice, even to an admin', async () => {
    const page = await list(people.admin);
    expect(page.items.map((item) => item.title)).not.toContain(
      'Removed cohort one',
    );
    expect(page.meta.total).toBe(ALL_TITLES.length);
    expect(noticesByTitle['Removed cohort one']).toBeDefined();
  });

  it('never shows a pinned notice outside the viewer scope', async () => {
    await db
      .update(notices)
      .set({ pinned: true })
      .where(eq(notices.id, noticesByTitle['Cohort two'].id));

    const page = await list(people.memberC1);
    expect(page.items.map((item) => item.title)).not.toContain('Cohort two');
    expect(page.meta.total).toBe(4);
  });
});

describe('ordering, paging and filters', () => {
  it('puts pinned notices first across the whole result, then newest, then id', async () => {
    await db.delete(notices);
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

  it('walks pages without repeats or gaps, even when a hidden notice is added between them', async () => {
    await db.delete(notices);
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

    const pageOne = await noticesService.list(
      people.memberC1,
      { page: 1, perPage: 2 } as never,
      NOW,
    );
    const seen = pageOne.items.map((item) => item.id);

    // Not visible to memberC1: it must not move the offset or the count.
    await db.insert(notices).values({
      authorId: people.admin.id,
      scope: NoticeScope.Cohort,
      cohortId: cohortIds.c2,
      title: 'Hidden between pages',
      body: 'x',
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
    });

    for (let page = 2; page <= 4; page++) {
      const result = await noticesService.list(
        people.memberC1,
        { page, perPage: 2 } as never,
        NOW,
      );
      seen.push(...result.items.map((item) => item.id));
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(7);
  });

  it('narrows by scope and cohort without ever widening', async () => {
    const byScope = await list(people.memberC1, {
      scope: NoticeScope.Cohort,
    });
    expect(byScope.items.map((item) => item.title)).toEqual(['Cohort one']);

    const byCohort = await list(people.memberC1, { cohortId: cohortIds.c1 });
    expect(byCohort.items.map((item) => item.title).sort()).toEqual([
      'Cohort one',
      'Cohort one track one',
      'Mentor group',
    ]);

    const both = await list(people.memberC1, {
      scope: NoticeScope.CohortTrack,
      cohortId: cohortIds.c1,
    });
    expect(both.items.map((item) => item.title)).toEqual([
      'Cohort one track one',
    ]);

    const outside = await list(people.memberC1, { cohortId: cohortIds.c2 });
    expect(outside.items).toEqual([]);
    expect(outside.meta.total).toBe(0);
  });

  it('lets a visible member narrow to a mentorship-group notice', async () => {
    const inPod = await list(people.memberC1, {
      scope: NoticeScope.MentorshipGroup,
    });
    expect(inPod.items.map((item) => item.title)).toEqual(['Mentor group']);

    const notInPod = await list(people.memberC2, {
      scope: NoticeScope.MentorshipGroup,
    });
    expect(notInPod.items).toEqual([]);
  });
});
