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
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { comments } from './../src/modules/comments/schema.js';
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
const db = drizzle(new PGlite(), { schema });

/** The wall over HTTP: visibility, ordering, comments and their refusals. */
describe('notice wall (e2e)', () => {
  let app: INestApplication<App>;
  let memberC1Cookie: string;
  let memberC2Cookie: string;
  let outsiderCookie: string;
  let adminCookie: string;
  let endedCookie: string;
  let memberC1Id: string;
  let adminId: string;
  let c2Id: string;
  let visibleId: string;
  let hiddenId: string;
  let otherId: string;
  let campusId: string;

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

  const list = (cookie: string, query = '') =>
    request(app.getHttpServer())
      .get(`/v1/notices${query}`)
      .set('Cookie', cookie);
  const listComments = (id: string, cookie = memberC1Cookie, query = '') =>
    request(app.getHttpServer())
      .get(`/v1/notices/${id}/comments${query}`)
      .set('Cookie', cookie);
  const addComment = (id: string, body: object, cookie = memberC1Cookie) =>
    request(app.getHttpServer())
      .post(`/v1/notices/${id}/comments`)
      .set('Cookie', cookie)
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
      sql`truncate comments, audit_log, notices, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

    const [memberC1, memberC2, outsider, admin, ended] = await db
      .insert(users)
      .values([
        { email: 'c1@campus.local' },
        { email: 'c2@campus.local' },
        { email: 'outsider@campus.local' },
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'ended@campus.local' },
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
        userId: ended.id,
        role: CohortRole.Student,
        status: StudentStatus.Active,
        cohortTrackId: c1t1.id,
        leftAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);

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
          title: 'C1',
          body: 'C1',
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
        },
        {
          authorId: admin.id,
          scope: NoticeScope.Cohort,
          cohortId: c2.id,
          title: 'C2',
          body: 'C2',
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
        },
        {
          authorId: admin.id,
          scope: NoticeScope.CohortTrack,
          cohortId: c1.id,
          cohortTrackId: c1t1.id,
          title: 'C1 T1',
          body: 'C1 T1',
          createdAt: new Date('2026-09-04T00:00:00.000Z'),
        },
        {
          authorId: admin.id,
          scope: NoticeScope.CohortTrack,
          cohortId: c1.id,
          cohortTrackId: c1t2.id,
          title: 'C1 T2',
          body: 'C1 T2',
          createdAt: new Date('2026-09-05T00:00:00.000Z'),
        },
        {
          authorId: admin.id,
          scope: NoticeScope.CohortTrack,
          cohortId: c2.id,
          cohortTrackId: c2t1.id,
          title: 'C2 T1',
          body: 'C2 T1',
          createdAt: new Date('2026-09-06T00:00:00.000Z'),
        },
      ])
      .returning();

    memberC1Id = memberC1.id;
    adminId = admin.id;
    c2Id = c2.id;
    campusId = created[0].id;
    visibleId = created[1].id;
    hiddenId = created[2].id;
    otherId = created[3].id;
    memberC1Cookie = await cookieFor(memberC1);
    memberC2Cookie = await cookieFor(memberC2);
    outsiderCookie = await cookieFor(outsider);
    adminCookie = await cookieFor(admin);
    endedCookie = await cookieFor(ended);
  });

  it('refuses every route without a session', async () => {
    await request(app.getHttpServer()).get('/v1/notices').expect(401);
    await request(app.getHttpServer())
      .get(`/v1/notices/${visibleId}/comments`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/v1/notices/${visibleId}/comments`)
      .send({ body: 'hello' })
      .expect(401);
  });

  it('serves each member only the notices they can see', async () => {
    const c1 = await list(memberC1Cookie).expect(200);
    expect(c1.body.items.map((item: { title: string }) => item.title)).toEqual([
      'C1 T1',
      'C1',
      'Campus',
    ]);

    const c2 = await list(memberC2Cookie).expect(200);
    expect(c2.body.items.map((item: { title: string }) => item.title)).toEqual([
      'C2 T1',
      'C2',
      'Campus',
    ]);

    const admin = await list(adminCookie).expect(200);
    expect(admin.body.items).toHaveLength(6);

    const none = await list(outsiderCookie).expect(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.meta.total).toBe(0);

    const left = await list(endedCookie).expect(200);
    expect(left.body.items).toEqual([]);
  });

  it('orders pinned first and filters without widening', async () => {
    await db
      .update(notices)
      .set({ pinned: true })
      .where(eq(notices.id, campusId));

    const page = await list(memberC1Cookie).expect(200);
    expect(page.body.items[0].id).toBe(campusId);

    const byScope = await list(
      memberC1Cookie,
      `?scope=${NoticeScope.CohortTrack}`,
    ).expect(200);
    expect(byScope.body.items.map((item: { id: string }) => item.id)).toEqual([
      otherId,
    ]);

    const outside = await list(memberC1Cookie, `?cohortId=${c2Id}`).expect(200);
    expect(outside.body.items).toEqual([]);
    expect(outside.body.meta.total).toBe(0);

    await list(memberC1Cookie, '?scope=everywhere').expect(400);
    await list(memberC1Cookie, `?cohortId=${MISSING}&page=0`).expect(400);
    await list(memberC1Cookie, '?perPage=101').expect(400);
  });

  it('comments as the caller, with the target from the URL and the date from the database', async () => {
    const res = await addComment(visibleId, {
      body: '  I can help.  ',
      authorId: adminId,
      targetId: hiddenId,
      targetType: 'project',
      createdAt: '2000-01-01T00:00:00.000Z',
    }).expect(201);

    expect(res.body).toMatchObject({
      authorId: memberC1Id,
      targetType: 'notice',
      targetId: visibleId,
      body: 'I can help.',
    });
    expect(new Date(res.body.createdAt).getUTCFullYear()).not.toBe(2000);

    const [stored] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, res.body.id));
    expect(stored).toMatchObject({
      authorId: memberC1Id,
      targetType: 'notice',
      targetId: visibleId,
      body: 'I can help.',
    });
    expect(await db.select().from(auditLog)).toEqual([
      expect.objectContaining({
        actorUserId: memberC1Id,
        action: AuditAction.CommentCreated,
        subjectType: AuditSubjectType.Comment,
        subjectId: res.body.id,
        details: { noticeId: visibleId },
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /comments_|notices_|cohort_members|author_id|target_id|target_type|created_at/,
    );
  });

  it('lists comments oldest first', async () => {
    for (const body of ['first', 'second', 'third']) {
      await addComment(visibleId, { body }).expect(201);
    }

    const res = await listComments(visibleId).expect(200);
    expect(res.body.items.map((item: { body: string }) => item.body)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(res.body.meta.total).toBe(3);
    expect(JSON.stringify(res.body)).not.toMatch(
      /comments_|notices_|cohort_members|author_id|target_id|target_type|created_at/,
    );
  });

  it('gives an outsider and a missing notice the same 404 body, for list and add', async () => {
    const outsideList = await listComments(hiddenId, outsiderCookie).expect(
      404,
    );
    const outsideAdd = await addComment(
      hiddenId,
      { body: 'nope' },
      outsiderCookie,
    ).expect(404);
    expect(outsideList.body).toEqual(outsideAdd.body);

    // Now the notice is actually gone. The same id must answer exactly as it
    // did when it existed but was out of scope.
    await db.delete(notices).where(eq(notices.id, hiddenId));
    const missingList = await listComments(hiddenId, outsiderCookie).expect(
      404,
    );
    const missingAdd = await addComment(
      hiddenId,
      { body: 'nope' },
      outsiderCookie,
    ).expect(404);
    expect(missingList.body).toEqual(outsideList.body);
    expect(missingAdd.body).toEqual(outsideAdd.body);

    const neverExisted = await listComments(MISSING, outsiderCookie).expect(
      404,
    );
    expect(neverExisted.body).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: `Notice ${MISSING} not found`,
        details: { noticeId: MISSING },
      },
    });

    expect(await db.select().from(comments)).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('answers malformed ids and bodies with 400', async () => {
    await listComments('not-a-uuid').expect(400);
    await addComment('not-a-uuid', { body: 'hello' }).expect(400);

    for (const body of ['', '   ', '\u0000', 'x'.repeat(2001)]) {
      await addComment(visibleId, { body }).expect(400);
    }

    const cleaned = await addComment(visibleId, {
      body: ' He\u0000llo ',
    }).expect(201);
    expect(cleaned.body.body).toBe('Hello');
  });

  it('throttles the add-comment route at 30 a minute', async () => {
    const client = '198.51.100.31';
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .post(`/v1/notices/${visibleId}/comments`)
        .set('Cookie', memberC1Cookie)
        .set('x-forwarded-for', client)
        .send({ body: `comment ${i}` })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/v1/notices/${visibleId}/comments`)
      .set('Cookie', memberC1Cookie)
      .set('x-forwarded-for', client)
      .send({ body: 'one too many' })
      .expect(429);
  }, 60_000);
});
