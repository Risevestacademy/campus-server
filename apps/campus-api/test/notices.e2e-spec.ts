import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import {
  AuditAction,
  AuditSubjectType,
  auditLog,
} from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  CommentTargetType,
  comments,
} from './../src/modules/comments/schema.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from './../src/modules/mentorship-groups/schema.js';
import { NoticeScope, notices } from './../src/modules/notices/schema.js';
import { tracks } from './../src/modules/tracks/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const MISSING = '00000000-0000-4000-8000-000000000000';
const INTERNAL_NAMES =
  /comments_|notices_|cohort_members|author_id|target_id|target_type|created_at/;
const db = drizzle(new PGlite(), { schema });

interface Person {
  id: string;
  cookie: string;
}

const ALL_TITLES = [
  'Campus',
  'Cohort one',
  'Cohort two',
  'Cohort one track one',
  'Cohort one track two',
  'Cohort two track one',
  'Mentor group',
] as const;

/** The wall over HTTP: visibility, ordering, comments and their refusals. */
describe('notice wall (e2e)', () => {
  let app: INestApplication<App>;
  let people: Record<string, Person>;
  let noticeIds: Record<string, string>;
  let cohortIds: { c1: string; c2: string };
  let nextIpNumber = 1;

  const nextIp = () => `198.51.100.${nextIpNumber++}`;

  const cookieFor = async (user: { id: string; email: string }) => {
    const { token } = await signSessionToken(
      {
        epoch: 0,
        userId: user.id,
        email: user.email,
        scope: SessionScope.FullAccess,
      },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  const getNotices = (cookie: string, query = '') =>
    request(app.getHttpServer())
      .get(`/v1/notices${query}`)
      .set('Cookie', cookie)
      .set('x-forwarded-for', nextIp());

  const getComments = (noticeId: string, cookie: string, query = '') =>
    request(app.getHttpServer())
      .get(`/v1/notices/${noticeId}/comments${query}`)
      .set('Cookie', cookie)
      .set('x-forwarded-for', nextIp());

  const postComment = (
    noticeId: string,
    body: object,
    cookie: string,
    ip = nextIp(),
  ) =>
    request(app.getHttpServer())
      .post(`/v1/notices/${noticeId}/comments`)
      .set('Cookie', cookie)
      .set('x-forwarded-for', ip)
      .send(body);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .compile();
    app = moduleFixture.createNestApplication({ logger: false });
    app.set('trust proxy', 1);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    app.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate comments, audit_log, notices, mentorship_group_students, mentorship_groups, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

    const createdUsers = await db
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
    ] = createdUsers;

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

    const [group] = await db
      .insert(mentorshipGroups)
      .values({
        cohortId: c1.id,
        mentorMemberId: memberships[7].id,
        name: 'Pod One',
      })
      .returning();
    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: group.id,
      cohortId: c1.id,
      cohortMemberId: memberships[0].id,
    });

    const created = await db
      .insert(notices)
      .values([
        {
          authorId: admin.id,
          scope: NoticeScope.Campus,
          title: 'Campus',
          body: 'Campus',
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

    const rows = [
      ['memberC1', memberC1],
      ['memberC2', memberC2],
      ['both', both],
      ['professorNoTrack', professorNoTrack],
      ['professorOnTrack', professorOnTrack],
      ['mentorNoTrack', mentorNoTrack],
      ['mentorOnTrack', mentorOnTrack],
      ['guestLive', guestLive],
      ['guestOnTrack', guestOnTrack],
      ['guestExpired', guestExpired],
      ['ended', ended],
      ['outsider', outsider],
      ['admin', admin],
    ] as const;
    people = {};
    for (const [key, user] of rows) {
      people[key] = { id: user.id, cookie: await cookieFor(user) };
    }

    noticeIds = Object.fromEntries(created.map((row) => [row.title, row.id]));
    cohortIds = { c1: c1.id, c2: c2.id };
  });

  it('refuses every route without a session', async () => {
    await request(app.getHttpServer())
      .get('/v1/notices')
      .set('x-forwarded-for', nextIp())
      .expect(401);
    await request(app.getHttpServer())
      .get(`/v1/notices/${noticeIds.Campus}/comments`)
      .set('x-forwarded-for', nextIp())
      .expect(401);
    await request(app.getHttpServer())
      .post(`/v1/notices/${noticeIds.Campus}/comments`)
      .set('x-forwarded-for', nextIp())
      .send({ body: 'hello' })
      .expect(401);
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
    [
      'a professor without a track',
      'professorNoTrack',
      ['Campus', 'Cohort one'],
    ],
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

  it.each(matrix)(
    '%s gets exactly their list, and the comment routes agree',
    async (_label, key, expected) => {
      const person = people[key];
      const res = await getNotices(person.cookie).expect(200);

      expect(
        res.body.items.map((item: { title: string }) => item.title).sort(),
      ).toEqual([...expected].sort());
      expect(res.body.meta.total).toBe(expected.length);

      const hidden = ALL_TITLES.filter((title) => !expected.includes(title));
      if (hidden.length > 0) {
        // Every hidden notice, not just the first: the cohort, track and
        // group rules must all hold on both comment routes.
        for (const title of hidden) {
          const noticeId = noticeIds[title];
          const listRes = await getComments(noticeId, person.cookie).expect(
            404,
          );
          const addRes = await postComment(
            noticeId,
            { body: 'not allowed' },
            person.cookie,
          ).expect(404);
          expect(addRes.body).toEqual(listRes.body);
        }
      } else {
        const noticeId = noticeIds.Campus;
        const listRes = await getComments(noticeId, person.cookie).expect(200);
        expect(listRes.body.meta.total).toBe(0);

        const addRes = await postComment(
          noticeId,
          { body: 'hello' },
          person.cookie,
        ).expect(201);
        expect(addRes.body.authorId).toBe(person.id);
      }
    },
  );

  it('never lists a removed notice, even to an admin', async () => {
    const res = await getNotices(people.admin.cookie).expect(200);
    expect(
      res.body.items.map((item: { title: string }) => item.title),
    ).not.toContain('Removed cohort one');
    expect(res.body.meta.total).toBe(ALL_TITLES.length);

    await getComments(
      noticeIds['Removed cohort one'],
      people.admin.cookie,
    ).expect(404);
  });

  it('orders pinned first and filters without widening', async () => {
    await db
      .update(notices)
      .set({ pinned: true })
      .where(eq(notices.id, noticeIds.Campus));

    const page = await getNotices(people.memberC1.cookie).expect(200);
    expect(page.body.items[0].id).toBe(noticeIds.Campus);

    const byScope = await getNotices(
      people.memberC1.cookie,
      `?scope=${NoticeScope.CohortTrack}`,
    ).expect(200);
    expect(byScope.body.items.map((item: { id: string }) => item.id)).toEqual([
      noticeIds['Cohort one track one'],
    ]);

    const byGroup = await getNotices(
      people.memberC1.cookie,
      `?scope=${NoticeScope.MentorshipGroup}`,
    ).expect(200);
    expect(byGroup.body.items.map((item: { id: string }) => item.id)).toEqual([
      noticeIds['Mentor group'],
    ]);

    const outside = await getNotices(
      people.memberC1.cookie,
      `?cohortId=${cohortIds.c2}`,
    ).expect(200);
    expect(outside.body.items).toEqual([]);
    expect(outside.body.meta.total).toBe(0);

    await getNotices(people.memberC1.cookie, '?scope=everywhere').expect(400);
    await getNotices(people.memberC1.cookie, '?cohortId=not-a-uuid').expect(
      400,
    );
    await getNotices(people.memberC1.cookie, '?page=0').expect(400);
    await getNotices(people.memberC1.cookie, '?perPage=101').expect(400);
  });

  it('uses the project’s default and maximum page sizes', async () => {
    await db.delete(notices);
    await db.insert(notices).values(
      Array.from({ length: 25 }, (_, i) => ({
        authorId: people.admin.id,
        scope: NoticeScope.Campus,
        title: `Notice ${i}`,
        body: 'x',
        createdAt: new Date(2026, 8, 1, 0, i),
      })),
    );

    const defaultPage = await getNotices(people.memberC1.cookie).expect(200);
    expect(defaultPage.body.items).toHaveLength(20);
    expect(defaultPage.body.meta).toMatchObject({
      page: 1,
      perPage: 20,
      total: 25,
    });

    const fullPage = await getNotices(
      people.memberC1.cookie,
      '?perPage=100',
    ).expect(200);
    expect(fullPage.body.items).toHaveLength(25);
  });

  it('never shows a pinned notice outside the viewer scope', async () => {
    await db
      .update(notices)
      .set({ pinned: true })
      .where(eq(notices.id, noticeIds['Cohort two']));

    const page = await getNotices(people.memberC1.cookie).expect(200);
    expect(
      page.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(noticeIds['Cohort two']);
    expect(page.body.meta.total).toBe(4);
  });

  it('comments as the caller, with the target from the URL and the date from the database', async () => {
    const res = await postComment(
      noticeIds['Cohort one'],
      {
        body: '  He\u0000llo  ',
        authorId: people.admin.id,
        targetId: noticeIds['Cohort two'],
        targetType: 'project',
        createdAt: '2000-01-01T00:00:00.000Z',
      },
      people.memberC1.cookie,
    ).expect(201);

    expect(res.body).toMatchObject({
      authorId: people.memberC1.id,
      body: 'Hello',
    });
    expect(res.body).not.toHaveProperty('targetType');
    expect(res.body).not.toHaveProperty('targetId');
    expect(new Date(res.body.createdAt).getUTCFullYear()).not.toBe(2000);
    expect(JSON.stringify(res.body)).not.toMatch(INTERNAL_NAMES);

    const [stored] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, res.body.id));
    expect(stored).toMatchObject({
      authorId: people.memberC1.id,
      targetType: CommentTargetType.Notice,
      targetId: noticeIds['Cohort one'],
      body: 'Hello',
    });

    const entries = await db.select().from(auditLog);
    expect(entries).toEqual([
      expect.objectContaining({
        actorUserId: people.memberC1.id,
        action: AuditAction.CommentCreated,
        subjectType: AuditSubjectType.Comment,
        subjectId: res.body.id,
        details: { noticeId: noticeIds['Cohort one'] },
      }),
    ]);
    expect(JSON.stringify(entries[0].details)).not.toContain('Hello');
  });

  it('lists comments oldest first, and never under another notice', async () => {
    for (const body of ['first', 'second', 'third']) {
      await postComment(
        noticeIds['Cohort one'],
        { body },
        people.memberC1.cookie,
      ).expect(201);
    }
    await postComment(
      noticeIds['Cohort one track one'],
      { body: 'other notice' },
      people.memberC1.cookie,
    ).expect(201);

    const res = await getComments(
      noticeIds['Cohort one'],
      people.memberC1.cookie,
    ).expect(200);
    expect(res.body.items.map((item: { body: string }) => item.body)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(res.body.meta.total).toBe(3);
    expect(JSON.stringify(res.body)).not.toMatch(INTERNAL_NAMES);
  });

  it('gives an outsider, a missing notice and a removed notice the same 404 body', async () => {
    const hidden = noticeIds['Cohort two'];
    const hiddenList = await getComments(hidden, people.outsider.cookie).expect(
      404,
    );
    const hiddenAdd = await postComment(
      hidden,
      { body: 'nope' },
      people.outsider.cookie,
    ).expect(404);
    expect(hiddenAdd.body).toEqual(hiddenList.body);

    const memberList = await getComments(hidden, people.memberC1.cookie).expect(
      404,
    );
    expect(memberList.body).toEqual(hiddenList.body);

    const missingList = await getComments(
      MISSING,
      people.memberC1.cookie,
    ).expect(404);
    expect(missingList.body).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: `Notice ${MISSING} not found`,
        details: { noticeId: MISSING },
      },
    });

    await db
      .update(notices)
      .set({ removedAt: new Date() })
      .where(eq(notices.id, hidden));
    const removedList = await getComments(
      hidden,
      people.outsider.cookie,
    ).expect(404);
    expect(removedList.body).toEqual(hiddenList.body);

    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('answers malformed ids and bodies with 400', async () => {
    await getComments('not-a-uuid', people.memberC1.cookie).expect(400);
    await postComment(
      'not-a-uuid',
      { body: 'hello' },
      people.memberC1.cookie,
    ).expect(400);

    for (const body of ['', '   ', '\u0000', 'x'.repeat(2001)]) {
      await postComment(
        noticeIds['Cohort one'],
        { body },
        people.memberC1.cookie,
      ).expect(400);
    }

    const cleaned = await postComment(
      noticeIds['Cohort one'],
      { body: ' He\u0000llo ' },
      people.memberC1.cookie,
    ).expect(201);
    expect(cleaned.body.body).toBe('Hello');
  });

  it('throttles the add-comment route at 30 a minute', async () => {
    // A bucket of its own: the rest of the suite uses 198.51.100.x, and this
    // block must not inherit a partially spent minute from it.
    const client = '203.0.113.31';
    for (let i = 0; i < 30; i++) {
      await postComment(
        noticeIds['Cohort one'],
        { body: `comment ${i}` },
        people.memberC1.cookie,
        client,
      ).expect(201);
    }

    await postComment(
      noticeIds['Cohort one'],
      { body: 'one too many' },
      people.memberC1.cookie,
      client,
    ).expect(429);
  }, 60_000);
});
