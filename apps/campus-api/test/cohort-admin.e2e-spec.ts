import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, and, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import {
  disabledEmailSender,
  EMAIL_SENDER,
} from './../src/infra/email/email-sender.js';
import {
  AuditAction,
  AuditSubjectType,
  auditLog,
} from './../src/modules/audit/schema.js';
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
import {
  REFRESH_COOKIE,
  SESSION_COOKIE,
} from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import { CohortRole, StudentStatus } from './../src/modules/cohorts/schema.js';
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
const MISSING = '99999999-9999-4999-8999-999999999999';
const ORIGIN = 'http://localhost:3000';
/**
 * A rate limiter that never counts. These routes are hammered by the tests —
 * five actions across setup, success, roster and revocation — which a real
 * 100-a-minute bucket would run through. The limit has its own test, against
 * an app that keeps the real one (rate-limit.e2e-spec.ts).
 */
const unlimited = {
  increment: async () => ({
    totalHits: 1,
    timeToExpire: 0,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
};
const db = drizzle(new PGlite(), { schema });

/**
 * The setup an invite depends on: a track, a cohort, and the link between
 * them whose id a student invite names. Admin-only throughout.
 */
describe('cohort and track admin routes (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  const as = (cookie: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .send(body),
    del: (path: string) =>
      request(app.getHttpServer())
        .delete(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000'),
  });

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

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue(disabledEmailSender)
      .overrideProvider(ThrottlerStorage)
      .useValue(unlimited)
      .compile();

    app = moduleFixture.createNestApplication();
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
    // Listening once, rather than app.init(): supertest otherwise opens a
    // server on a new port for every request, and files running in parallel
    // collide on them.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local', systemRole: SystemRole.User })
      .returning();
    adminId = admin.id;
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
  });

  const createTrack = (
    body: object = { name: 'Software Engineering', code: 'se' },
  ) => as(adminCookie).post('/v1/tracks', body);
  const createCohort = (body: object = { name: 'Cohort 1', code: 'c1' }) =>
    as(adminCookie).post('/v1/cohorts', body);

  describe('access', () => {
    it.each([
      ['post', '/v1/tracks'],
      ['get', '/v1/tracks'],
      ['patch', `/v1/tracks/${MISSING}`],
      ['delete', `/v1/tracks/${MISSING}`],
      ['post', '/v1/cohorts'],
      ['get', '/v1/cohorts'],
      ['get', `/v1/cohorts/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}`],
      ['delete', `/v1/cohorts/${MISSING}`],
      ['post', `/v1/cohorts/${MISSING}/tracks`],
      ['patch', `/v1/cohorts/${MISSING}/members/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/members/${MISSING}/track`],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    it.each([
      ['post', '/v1/tracks'],
      ['get', '/v1/tracks'],
      ['patch', `/v1/tracks/${MISSING}`],
      ['delete', `/v1/tracks/${MISSING}`],
      ['post', '/v1/cohorts'],
      ['get', '/v1/cohorts'],
      ['patch', `/v1/cohorts/${MISSING}`],
      ['delete', `/v1/cohorts/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/members/${MISSING}`],
      ['patch', `/v1/cohorts/${MISSING}/members/${MISSING}/track`],
    ] as const)('refuses %s %s to a non-admin', async (method, path) => {
      const res =
        method === 'get'
          ? await as(memberCookie).get(path)
          : method === 'delete'
            ? await as(memberCookie).del(path)
            : method === 'patch'
              ? await as(memberCookie).patch(path, {})
              : await as(memberCookie).post(path, {});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('tracks', () => {
    it('creates a track with its code uppercased', async () => {
      const res = await createTrack({
        name: '  Software Engineering ',
        code: ' se ',
        description: 'Backend and infra',
      }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Software Engineering',
        code: 'SE',
        description: 'Backend and infra',
      });
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('refuses a code another track has, whatever its case', async () => {
      await createTrack().expect(201);
      const res = await createTrack({ name: 'Other', code: 'SE' }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { code: 'SE' },
      });
    });

    it('refuses a code with spaces in it', async () => {
      await createTrack({ name: 'Bad', code: 'S E' }).expect(400);
    });

    it('lists tracks by name, a page at a time', async () => {
      await createTrack({ name: 'Product Design', code: 'PD' }).expect(201);
      await createTrack({ name: 'Data Science', code: 'DS' }).expect(201);

      const res = await as(adminCookie)
        .get('/v1/tracks?perPage=1&page=2')
        .expect(200);
      expect(res.body.items.map((t: { code: string }) => t.code)).toEqual([
        'PD',
      ]);
      expect(res.body.meta).toEqual({
        page: 2,
        perPage: 1,
        total: 2,
        totalPages: 2,
      });
    });
  });

  /**
   * A page number far past any data reaches the database as an offset too
   * large for it, which answered 500. It is the caller's mistake, so it is
   * refused before the query; a page merely past the end is an empty one.
   */
  describe('a page number past any real list', () => {
    it('answers an empty page for a page past the end', async () => {
      await createTrack().expect(201);

      const res = await as(adminCookie)
        .get('/v1/tracks?page=10000&perPage=100')
        .expect(200);
      expect(res.body.items).toEqual([]);
    });

    it.each(['1e30', '9007199254740993', '10001'])(
      "refuses page=%s as the caller's mistake, not a 500",
      async (page) => {
        const res = await as(adminCookie)
          .get(`/v1/tracks?page=${page}`)
          .expect(400);
        expect(res.body.error).toMatchObject({
          code: 'INVALID_ARGUMENT',
          details: { fields: { page: expect.any(String) } },
        });
      },
    );
  });

  describe('updating tracks', () => {
    it('writes the fields present and uppercases a new code', async () => {
      const track = (await createTrack().expect(201)).body;

      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, {
          name: '  Data Engineering ',
          code: ' de ',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        id: track.id,
        name: 'Data Engineering',
        code: 'DE',
        description: null,
      });

      const reread = await db.query.tracks.findFirst({
        where: eq(schema.tracks.id, track.id),
      });
      expect(reread).toMatchObject({ name: 'Data Engineering', code: 'DE' });
    });

    it('clears the description on an empty string and keeps the rest', async () => {
      const track = (
        await createTrack({
          name: 'Software Engineering',
          code: 'se',
          description: 'Backend and infra',
        }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { description: '' })
        .expect(200);
      expect(res.body).toMatchObject({
        id: track.id,
        name: 'Software Engineering',
        code: 'SE',
        description: null,
      });
    });

    it('refuses a code another track has, whatever its case', async () => {
      await createTrack().expect(201);
      const other = (
        await createTrack({ name: 'Other', code: 'DS' }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/tracks/${other.id}`, { code: 'se' })
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { code: 'SE' },
      });

      const reread = await db.query.tracks.findFirst({
        where: eq(schema.tracks.id, other.id),
      });
      expect(reread).toMatchObject({ code: 'DS' });
    });

    it('refuses a malformed code', async () => {
      const track = (await createTrack().expect(201)).body;
      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { code: 'S E' })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('ignores an id in the body', async () => {
      const track = (await createTrack().expect(201)).body;
      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { id: MISSING })
        .expect(200);
      expect(res.body.id).toBe(track.id);
    });

    it('answers 404 for a missing track and 400 for a bad id', async () => {
      await as(adminCookie).patch(`/v1/tracks/${MISSING}`, {}).expect(404);
      await as(adminCookie).patch('/v1/tracks/not-a-uuid', {}).expect(400);
    });

    // Optional on a PATCH, but not clearable: null used to reach the NOT NULL
    // column and answer 500.
    it.each(['name', 'code'])('refuses a null %s', async (field) => {
      const track = (await createTrack().expect(201)).body;
      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { [field]: null })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('clears the description on null', async () => {
      const track = (
        await createTrack({
          name: 'Software Engineering',
          code: 'se',
          description: 'Backend and infra',
        }).expect(201)
      ).body;
      const res = await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { description: null })
        .expect(200);
      expect(res.body.description).toBeNull();
    });
  });

  describe('deleting tracks', () => {
    it('deletes a track no cohort runs', async () => {
      const track = (await createTrack().expect(201)).body;

      await as(adminCookie).del(`/v1/tracks/${track.id}`).expect(204);

      expect(
        await db.query.tracks.findFirst({
          where: eq(schema.tracks.id, track.id),
        }),
      ).toBeUndefined();
      const list = await as(adminCookie).get('/v1/tracks').expect(200);
      expect(list.body.items).toHaveLength(0);
    });

    it('answers 404 for a missing track and 400 for a bad id', async () => {
      await as(adminCookie).del(`/v1/tracks/${MISSING}`).expect(404);
      await as(adminCookie).del('/v1/tracks/not-a-uuid').expect(400);
    });

    it('refuses to delete a track a cohort still runs', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      await as(adminCookie)
        .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
        .expect(201);

      const res = await as(adminCookie)
        .del(`/v1/tracks/${track.id}`)
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { trackId: track.id },
      });

      expect(
        await db.query.tracks.findFirst({
          where: eq(schema.tracks.id, track.id),
        }),
      ).toBeDefined();
    });
  });

  describe('cohorts', () => {
    it('creates an upcoming cohort by default', async () => {
      const res = await createCohort({
        name: 'Cohort 1',
        code: 'c1',
        startDate: '2026-09-01',
        endDate: '2027-06-30',
      }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Cohort 1',
        code: 'C1',
        startDate: '2026-09-01',
        endDate: '2027-06-30',
        status: 'upcoming',
      });
    });

    // The documented validation shape: clients map details.fields to inputs.
    it('refuses an end date before the start date, as a field error', async () => {
      const res = await createCohort({
        name: 'Cohort 1',
        code: 'C1',
        startDate: '2027-01-01',
        endDate: '2026-09-01',
      }).expect(400);
      expect(res.body).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Request validation failed',
          details: {
            fields: { endDate: 'endDate must be on or after startDate' },
          },
        },
      });
    });

    it.each([
      ['on the same day', { startDate: '2026-09-01', endDate: '2026-09-01' }],
      ['with no start date', { endDate: '2026-09-01' }],
    ])('accepts an end date %s', async (_label, dates) => {
      await createCohort({ name: 'Cohort 1', code: 'C1', ...dates }).expect(
        201,
      );
    });

    it.each(['2026-02-30', '2026-09-01T00:00:00Z'])(
      'refuses %s as a date',
      async (startDate) => {
        await createCohort({ name: 'Cohort 1', code: 'C1', startDate }).expect(
          400,
        );
      },
    );

    it('refuses a code another cohort has', async () => {
      await createCohort().expect(201);
      await createCohort({ name: 'Again', code: 'C1' }).expect(409);
    });

    it('lists cohorts', async () => {
      await createCohort().expect(201);
      const res = await as(adminCookie).get('/v1/cohorts').expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
    });
  });

  describe('updating cohorts', () => {
    it('writes the fields present and uppercases a new code', async () => {
      const cohort = (
        await createCohort({
          name: 'Cohort 1',
          code: 'c1',
          startDate: '2026-09-01',
          endDate: '2027-06-30',
        }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, {
          name: '  Cohort One ',
          code: ' c-one ',
          status: 'active',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        id: cohort.id,
        name: 'Cohort One',
        code: 'C-ONE',
        status: 'active',
        startDate: '2026-09-01',
        endDate: '2027-06-30',
      });

      const reread = await db.query.cohorts.findFirst({
        where: eq(schema.cohorts.id, cohort.id),
      });
      expect(reread).toMatchObject({ name: 'Cohort One', code: 'C-ONE' });
    });

    // The DTO cannot see the stored half of the pair, so the merged range is
    // checked in the service and reported like any other field error.
    it('refuses an end date before the stored start date', async () => {
      const cohort = (
        await createCohort({
          name: 'Cohort 1',
          code: 'C1',
          startDate: '2026-09-01',
        }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, { endDate: '2026-08-31' })
        .expect(400);
      expect(res.body).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Request validation failed',
          details: {
            fields: { endDate: 'endDate must be on or after startDate' },
          },
        },
      });

      const reread = await db.query.cohorts.findFirst({
        where: eq(schema.cohorts.id, cohort.id),
      });
      expect(reread?.endDate).toBeNull();
    });

    it('refuses a code another cohort has', async () => {
      await createCohort().expect(201);
      const other = (
        await createCohort({ name: 'Again', code: 'C2' }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${other.id}`, { code: 'c1' })
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { code: 'C1' },
      });

      const reread = await db.query.cohorts.findFirst({
        where: eq(schema.cohorts.id, other.id),
      });
      expect(reread).toMatchObject({ code: 'C2' });
    });

    it('ignores an id in the body', async () => {
      const cohort = (await createCohort().expect(201)).body;
      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, { id: MISSING })
        .expect(200);
      expect(res.body.id).toBe(cohort.id);
    });

    it('answers 404 for a missing cohort and 400 for a bad id', async () => {
      await as(adminCookie).patch(`/v1/cohorts/${MISSING}`, {}).expect(404);
      await as(adminCookie).patch('/v1/cohorts/not-a-uuid', {}).expect(400);
    });

    // Optional on a PATCH, but not clearable: null used to reach the NOT NULL
    // column and answer 500.
    it.each(['name', 'code', 'status'])('refuses a null %s', async (field) => {
      const cohort = (await createCohort().expect(201)).body;
      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, { [field]: null })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    });

    // The dates are optional at create, so null is how one is unset.
    it('clears a date on null and keeps the other', async () => {
      const cohort = (
        await createCohort({
          name: 'Cohort 1',
          code: 'c1',
          startDate: '2026-09-01',
          endDate: '2027-06-30',
        }).expect(201)
      ).body;

      const res = await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, { startDate: null })
        .expect(200);
      expect(res.body.startDate).toBeNull();
      expect(res.body.endDate).toBe('2027-06-30');
    });
  });

  describe('deleting cohorts', () => {
    it('deletes a cohort with nothing attached', async () => {
      const cohort = (await createCohort().expect(201)).body;

      await as(adminCookie).del(`/v1/cohorts/${cohort.id}`).expect(204);
      await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(404);

      expect(
        await db.query.cohorts.findFirst({
          where: eq(schema.cohorts.id, cohort.id),
        }),
      ).toBeUndefined();
    });

    it('answers 404 for a missing cohort and 400 for a bad id', async () => {
      await as(adminCookie).del(`/v1/cohorts/${MISSING}`).expect(404);
      await as(adminCookie).del('/v1/cohorts/not-a-uuid').expect(400);
    });

    it('refuses to delete a cohort that still runs tracks', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      await as(adminCookie)
        .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
        .expect(201);

      const res = await as(adminCookie)
        .del(`/v1/cohorts/${cohort.id}`)
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { cohortId: cohort.id },
      });
      await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200);
    });

    it('refuses to delete a cohort that still has members', async () => {
      const cohort = (await createCohort().expect(201)).body;
      const [member] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'member@campus.local'));
      await db.insert(schema.cohortMembers).values({
        cohortId: cohort.id,
        userId: member.id,
        role: CohortRole.Professor,
      });

      const res = await as(adminCookie)
        .del(`/v1/cohorts/${cohort.id}`)
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200);
    });

    it('refuses to delete a cohort that still has invites', async () => {
      const cohort = (await createCohort().expect(201)).body;
      await as(adminCookie)
        .post('/v1/invites', {
          email: 'prof@campus.local',
          cohortId: cohort.id,
          cohortRole: CohortRole.Professor,
        })
        .expect(201);

      const res = await as(adminCookie)
        .del(`/v1/cohorts/${cohort.id}`)
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200);
    });
  });

  describe('attaching tracks', () => {
    it('attaches a track, shows it on the cohort, and an invite can use it', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;

      const link = (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
          .expect(201)
      ).body;
      expect(link).toMatchObject({
        cohortId: cohort.id,
        track: { id: track.id, code: 'SE' },
      });

      const detail = (
        await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200)
      ).body;
      expect(detail.code).toBe('C1');
      expect(detail.tracks).toEqual([
        expect.objectContaining({
          id: link.id,
          track: expect.objectContaining({ id: track.id }),
        }),
      ]);

      // The point of all of this: the link's id is what a student invite names.
      await as(adminCookie)
        .post('/v1/invites', {
          email: 'student@campus.local',
          cohortId: cohort.id,
          cohortRole: CohortRole.Student,
          cohortTrackId: link.id,
        })
        .expect(201);
    });

    it('refuses to attach the same track twice', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      const attach = () =>
        as(adminCookie).post(`/v1/cohorts/${cohort.id}/tracks`, {
          trackId: track.id,
        });

      await attach().expect(201);
      const res = await attach().expect(409);
      expect(res.body.error.message).toBe(
        'Track SE is already attached to this cohort',
      );
    });

    it('answers 404 for a missing cohort or track', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;

      await as(adminCookie)
        .post(`/v1/cohorts/${MISSING}/tracks`, { trackId: track.id })
        .expect(404);
      await as(adminCookie)
        .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: MISSING })
        .expect(404);
      await as(adminCookie).get(`/v1/cohorts/${MISSING}`).expect(404);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      await as(adminCookie).get('/v1/cohorts/not-a-uuid').expect(400);
    });
  });

  describe('detaching tracks', () => {
    const MISSING = '99999999-9999-4999-8999-999999999999';

    /** A cohort running one track, as the two routes above leave it. */
    const running = async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      const link = (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
          .expect(201)
      ).body;
      return { track, cohort, link };
    };
    const detach = (cohortId: string, trackId: string, cookie = adminCookie) =>
      as(cookie).del(`/v1/cohorts/${cohortId}/tracks/${trackId}`);

    it('detaches a track, and leaves the track in the catalogue', async () => {
      const { track, cohort } = await running();

      await detach(cohort.id, track.id).expect(204);

      const detail = (
        await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200)
      ).body;
      expect(detail.tracks).toEqual([]);
      const listed = (await as(adminCookie).get('/v1/tracks').expect(200)).body;
      expect(listed.items).toEqual([expect.objectContaining({ id: track.id })]);
    });

    // The reason the route exists: a cohort that runs a track cannot be
    // deleted, and until now nothing could take the track off.
    it('lets the cohort be deleted afterwards', async () => {
      const { track, cohort } = await running();
      await as(adminCookie).del(`/v1/cohorts/${cohort.id}`).expect(409);

      await detach(cohort.id, track.id).expect(204);

      await as(adminCookie).del(`/v1/cohorts/${cohort.id}`).expect(204);
    });

    it('lets the same track be attached again', async () => {
      const { track, cohort } = await running();
      await detach(cohort.id, track.id).expect(204);

      await as(adminCookie)
        .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
        .expect(201);
    });

    it('only detaches from the cohort it names', async () => {
      const { track, cohort } = await running();
      const other = (
        await createCohort({ name: 'Cohort 2', code: 'c2' }).expect(201)
      ).body;
      await as(adminCookie)
        .post(`/v1/cohorts/${other.id}/tracks`, { trackId: track.id })
        .expect(201);

      await detach(cohort.id, track.id).expect(204);

      const detail = (
        await as(adminCookie).get(`/v1/cohorts/${other.id}`).expect(200)
      ).body;
      expect(detail.tracks).toHaveLength(1);
    });

    it('refuses while a student in the cohort is on the track', async () => {
      const { track, cohort, link } = await running();
      const [member] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'member@campus.local'));
      await db.insert(schema.cohortMembers).values({
        cohortId: cohort.id,
        userId: member.id,
        cohortTrackId: link.id,
        role: CohortRole.Student,
        status: 'active',
      });

      const res = await detach(cohort.id, track.id).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { cohortId: cohort.id, trackId: track.id },
      });
      const detail = (
        await as(adminCookie).get(`/v1/cohorts/${cohort.id}`).expect(200)
      ).body;
      expect(detail.tracks).toHaveLength(1);
    });

    it('refuses while an invite to the cohort names the track', async () => {
      const { track, cohort, link } = await running();
      await as(adminCookie)
        .post('/v1/invites', {
          email: 'student@campus.local',
          cohortId: cohort.id,
          cohortRole: CohortRole.Student,
          cohortTrackId: link.id,
        })
        .expect(201);

      await detach(cohort.id, track.id).expect(409);
    });

    // Staff carry no track, so they are no obstacle to taking one off.
    it('is not held up by a member who is not on the track', async () => {
      const { track, cohort } = await running();
      const [member] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'member@campus.local'));
      await db.insert(schema.cohortMembers).values({
        cohortId: cohort.id,
        userId: member.id,
        role: CohortRole.Professor,
      });

      await detach(cohort.id, track.id).expect(204);
    });

    it('answers 404 for a missing cohort, and for a track the cohort does not run', async () => {
      const { track, cohort } = await running();
      const unattached = (
        await createTrack({ name: 'Product Design', code: 'pd' }).expect(201)
      ).body;

      const noCohort = await detach(MISSING, track.id).expect(404);
      expect(noCohort.body.error.details).toEqual({ cohortId: MISSING });

      const notAttached = await detach(cohort.id, unattached.id).expect(404);
      expect(notAttached.body.error.message).toContain(
        'is not attached to this cohort',
      );
    });

    it('answers a second detach with 404', async () => {
      const { track, cohort } = await running();
      await detach(cohort.id, track.id).expect(204);

      await detach(cohort.id, track.id).expect(404);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      const { track, cohort } = await running();

      await detach('not-a-uuid', track.id).expect(400);
      await detach(cohort.id, 'not-a-uuid').expect(400);
    });

    it('is for admins only', async () => {
      const { track, cohort } = await running();

      await detach(cohort.id, track.id, memberCookie).expect(403);
      await request(app.getHttpServer())
        .delete(`/v1/cohorts/${cohort.id}/tracks/${track.id}`)
        .expect(401);
    });

    it('records who detached it, and nothing when the detach is refused', async () => {
      const { track, cohort, link } = await running();
      await as(adminCookie)
        .post('/v1/invites', {
          email: 'student@campus.local',
          cohortId: cohort.id,
          cohortRole: CohortRole.Student,
          cohortTrackId: link.id,
        })
        .expect(201);
      const detached = () =>
        db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, AuditAction.CohortTrackDetached));

      await detach(cohort.id, track.id).expect(409);
      expect(await detached()).toHaveLength(0);

      await db.execute(sql`delete from invites`);
      await detach(cohort.id, track.id).expect(204);

      expect(await detached()).toEqual([
        expect.objectContaining({
          actorUserId: adminId,
          subjectType: AuditSubjectType.CohortTrack,
          subjectId: link.id,
          details: { cohortId: cohort.id, trackId: track.id },
        }),
      ]);
    });
  });

  /**
   * A guest's visit ends on the deadline they accepted with the invite. An
   * admin moving it forward is the one extension that needs no sign-in: the
   * route writes the new end, and the session layer reads it from the
   * membership at the guest's next refresh.
   */
  describe('guest visits', () => {
    const HOUR = 3_600_000;
    let cohortId: string;

    beforeEach(async () => {
      const cohort = (await createCohort().expect(201)).body;
      cohortId = cohort.id;
    });

    const guestWithVisit = async (accessExpiresAt: Date) => {
      const [guest] = await db
        .insert(users)
        .values({ email: 'guest@campus.local', systemRole: SystemRole.User })
        .returning();
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: guest.id,
        role: CohortRole.Guest,
        accessExpiresAt,
      });
      return guest;
    };

    const extend = (userId: string, accessExpiresAt: string) =>
      as(adminCookie).patch(`/v1/cohorts/${cohortId}/members/${userId}`, {
        accessExpiresAt,
      });

    const visitOf = async (userId: string) => {
      const [row] = await db
        .select({ accessExpiresAt: schema.cohortMembers.accessExpiresAt })
        .from(schema.cohortMembers)
        .where(eq(schema.cohortMembers.userId, userId));
      return row.accessExpiresAt;
    };

    // Creating the cohort in beforeEach writes an entry of its own, so what
    // these tests ask is whether one about the visit exists.
    const visitEntries = () =>
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.GuestVisitExtended));

    it("moves a guest's visit end forward, and records who moved it", async () => {
      const previous = new Date(Date.now() + 60_000);
      const guest = await guestWithVisit(previous);
      const accessExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

      const res = await extend(guest.id, accessExpiresAt).expect(200);

      expect(res.body).toEqual({
        id: expect.any(String),
        cohortId,
        userId: guest.id,
        role: CohortRole.Guest,
        accessExpiresAt,
      });
      expect(await visitOf(guest.id)).toEqual(new Date(accessExpiresAt));

      expect(await visitEntries()).toEqual([
        expect.objectContaining({
          actorUserId: adminId,
          action: AuditAction.GuestVisitExtended,
          subjectType: AuditSubjectType.CohortMember,
          subjectId: res.body.id,
          details: {
            cohortId,
            accessExpiresAt,
            previousAccessExpiresAt: previous.toISOString(),
          },
        }),
      ]);
    });

    /**
     * The guest accepted a deadline, and a visit that ran out is brought
     * back by an invite — which records that they were asked again, where
     * moving the date here would not.
     */
    it('refuses a visit that has already ended, and records nothing', async () => {
      const previous = new Date(Date.now() - 60_000);
      const guest = await guestWithVisit(previous);

      const res = await extend(
        guest.id,
        new Date(Date.now() + HOUR).toISOString(),
      ).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'The visit has already ended; send a new invite',
        details: { cohortId, userId: guest.id },
      });
      expect(await visitOf(guest.id)).toEqual(previous);
      expect(await visitEntries()).toHaveLength(0);
    });

    it('refuses a membership that has left', async () => {
      const guest = await guestWithVisit(new Date(Date.now() + HOUR));
      await db
        .update(schema.cohortMembers)
        .set({ leftAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.cohortMembers.userId, guest.id));

      const res = await extend(
        guest.id,
        new Date(Date.now() + 2 * HOUR).toISOString(),
      ).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'That membership has already ended',
      });
      expect(await visitEntries()).toHaveLength(0);
    });

    it('refuses a member whose place is not a visit', async () => {
      const [member] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'member@campus.local'));
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: member.id,
        role: CohortRole.Professor,
      });

      const res = await extend(
        member.id,
        new Date(Date.now() + HOUR).toISOString(),
      ).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'Only a guest has a visit to extend',
        details: { role: CohortRole.Professor },
      });
      expect(await visitEntries()).toHaveLength(0);
    });

    it('refuses an end date that is not in the future', async () => {
      const previous = new Date(Date.now() + HOUR);
      const guest = await guestWithVisit(previous);

      const res = await extend(
        guest.id,
        new Date(Date.now() - 60_000).toISOString(),
      ).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: {
          fields: { accessExpiresAt: expect.stringMatching(/in the future/) },
        },
      });
      expect(await visitOf(guest.id)).toEqual(previous);
      expect(await visitEntries()).toHaveLength(0);
    });

    // Forms the request check lets through and Date cannot read. Unguarded,
    // they reached the UPDATE as an invalid date and answered 500.
    it.each(['2099-W43-2', '20991020', '2099-293'])(
      'refuses %s, an ISO form that is not a readable date, as a field error',
      async (value) => {
        const previous = new Date(Date.now() + HOUR);
        const guest = await guestWithVisit(previous);

        const res = await extend(guest.id, value).expect(400);

        expect(res.body.error).toMatchObject({
          code: 'INVALID_ARGUMENT',
          details: {
            fields: { accessExpiresAt: expect.stringMatching(/not a date/) },
          },
        });
        expect(await visitOf(guest.id)).toEqual(previous);
        expect(await visitEntries()).toHaveLength(0);
      },
    );

    it('refuses an end date no later than the one the visit already has', async () => {
      const previous = new Date(Date.now() + HOUR);
      const guest = await guestWithVisit(previous);

      const res = await extend(guest.id, previous.toISOString()).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: {
          fields: {
            accessExpiresAt: expect.stringMatching(/later than the visit end/),
          },
        },
      });
      expect(await visitOf(guest.id)).toEqual(previous);
    });

    it('answers 404 for a user with no membership in the cohort', async () => {
      const res = await extend(
        MISSING,
        new Date(Date.now() + HOUR).toISOString(),
      ).expect(404);

      expect(res.body.error).toMatchObject({
        code: 'NOT_FOUND',
        details: { cohortId, userId: MISSING },
      });
      expect(await visitEntries()).toHaveLength(0);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      await as(adminCookie)
        .patch(`/v1/cohorts/not-a-uuid/members/${MISSING}`, {
          accessExpiresAt: new Date(Date.now() + HOUR).toISOString(),
        })
        .expect(400);
    });

    // SessionGuard checks the origin of any cookie-carrying mutation, so a
    // cross-site form cannot move a visit even with an admin's cookie.
    it('refuses a cross-site request to move the visit', async () => {
      const previous = new Date(Date.now() + HOUR);
      const guest = await guestWithVisit(previous);

      await request(app.getHttpServer())
        .patch(`/v1/cohorts/${cohortId}/members/${guest.id}`)
        .set('Cookie', adminCookie)
        .set('Origin', 'https://attacker.example')
        .send({
          accessExpiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        })
        .expect(401);

      expect(await visitOf(guest.id)).toEqual(previous);
      expect(await visitEntries()).toHaveLength(0);
    });

    /**
     * Why the guest does not have to sign in again: the token they hold was
     * minted against the old end, and the refresh after an extension mints
     * the next one against the new one.
     */
    it("carries the new end onto the guest's next refresh", async () => {
      const visitEnd = new Date(Date.now() + 4 * 60_000);
      const extended = new Date(Date.now() + 8 * 60_000);
      const guest = await guestWithVisit(visitEnd);
      const issued = await app
        .get(SessionIssuer)
        .issueFullAccess(guest, { endsAt: visitEnd });
      expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(
        visitEnd.getTime(),
      );

      await extend(guest.id, extended.toISOString()).expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
        .set('Origin', ORIGIN)
        .expect(200);

      const expiresAt = new Date(response.body.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(visitEnd.getTime());
      expect(expiresAt).toBeLessThanOrEqual(extended.getTime());
    });
  });

  /**
   * The five ways an admin ends a membership. Each one writes the end, an
   * entry and the revocation of the member's sessions in one transaction, so
   * the next request with the session they already held is refused.
   */
  describe('ending memberships', () => {
    let cohortId: string;
    let linkId: string;

    beforeEach(async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      const link = (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
          .expect(201)
      ).body;
      cohortId = cohort.id;
      linkId = link.id;
    });

    const memberOf = async (email = 'member@campus.local') => {
      const [row] = await db.select().from(users).where(eq(users.email, email));
      return row;
    };

    const makeStudent = async (email = 'member@campus.local') => {
      const user = await memberOf(email);
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: user.id,
        cohortTrackId: linkId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      });
      return user;
    };

    const end = (
      action: string,
      userId: string,
      body: object = {},
      cookie = adminCookie,
    ) =>
      as(cookie).post(
        `/v1/cohorts/${cohortId}/members/${userId}/${action}`,
        body,
      );

    const endedEntries = () =>
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.MembershipEnded));

    const ACTIONS = [
      ['dismiss', StudentStatus.Dismissed],
      ['withdraw', StudentStatus.Withdrawn],
      ['defer', StudentStatus.Deferred],
      ['graduate', StudentStatus.Graduated],
      ['remove', null],
    ] as const;

    const reasonFor = (action: string) =>
      action === 'dismiss' ? 'Posted the answer' : 'No longer attending';

    it.each(ACTIONS)(
      '%s ends the membership and records the admin',
      async (action, status) => {
        const member = await makeStudent();
        const reason = reasonFor(action);

        const res = await end(action, member.id, { reason }).expect(200);

        expect(res.body).toEqual({
          id: expect.any(String),
          cohortId,
          userId: member.id,
          role: CohortRole.Student,
          status,
          leftAt: expect.any(String),
          reason,
        });

        expect(await endedEntries()).toEqual([
          expect.objectContaining({
            actorUserId: adminId,
            subjectType: AuditSubjectType.CohortMember,
            subjectId: res.body.id,
            details: {
              cohortId,
              role: CohortRole.Student,
              status,
              reason,
            },
          }),
        ]);
      },
    );

    it.each(ACTIONS)('%s is admin only', async (action) => {
      const member = await makeStudent();

      await request(app.getHttpServer())
        .post(`/v1/cohorts/${cohortId}/members/${member.id}/${action}`)
        .send({ reason: 'x' })
        .expect(401);

      const res = await end(action, member.id, { reason: 'x' }, memberCookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it.each(ACTIONS)(
      '%s refuses the member’s next request with the session they already held',
      async (action) => {
        const member = await makeStudent();
        await as(memberCookie).get('/v1/auth/me').expect(200);

        await end(action, member.id, { reason: reasonFor(action) }).expect(200);

        const res = await as(memberCookie).get('/v1/auth/me');
        expect(res.status).toBe(401);
      },
    );

    it.each(ACTIONS)(
      '%s leaves the member under state=ended with the status and reason, and off the default roster',
      async (action, status) => {
        const member = await makeStudent();
        const reason = reasonFor(action);

        await end(action, member.id, { reason }).expect(200);

        const ended = await as(adminCookie)
          .get(`/v1/cohorts/${cohortId}/members?state=ended`)
          .expect(200);
        expect(ended.body.items).toEqual([
          expect.objectContaining({
            user: expect.objectContaining({ email: 'member@campus.local' }),
            role: CohortRole.Student,
            status,
            state: 'ended',
            dismissalReason: reason,
          }),
        ]);

        const live = await as(adminCookie)
          .get(`/v1/cohorts/${cohortId}/members`)
          .expect(200);
        expect(live.body.items).toEqual([]);
      },
    );

    it('answers 400 for a bad id and 404 for no such membership', async () => {
      const member = await makeStudent();

      await end('dismiss', member.id, { reason: 'x' }, adminCookie);
      await as(adminCookie)
        .post(`/v1/cohorts/not-a-uuid/members/${member.id}/dismiss`, {
          reason: 'x',
        })
        .expect(400);
      await as(adminCookie)
        .post(`/v1/cohorts/${cohortId}/members/not-a-uuid/dismiss`, {
          reason: 'x',
        })
        .expect(400);
      await as(adminCookie)
        .post(`/v1/cohorts/${cohortId}/members/${MISSING}/remove`, {})
        .expect(404);
    });

    // The action is the URL, so a status or an end date in the body is a
    // different kind of end being attempted and must not reach the row.
    it('ignores status and endDate in the body', async () => {
      const member = await makeStudent();

      const res = await end('dismiss', member.id, {
        reason: 'Posted the answer',
        status: StudentStatus.Graduated,
        endDate: '2020-01-01T00:00:00.000Z',
        unknown: 'ignored',
      }).expect(200);

      expect(res.body.status).toBe(StudentStatus.Dismissed);
      expect(new Date(res.body.leftAt).getFullYear()).toBeGreaterThan(2020);
    });

    it.each(ACTIONS)('%s refuses a second end with a 409', async (action) => {
      const member = await makeStudent();
      const reason = reasonFor(action);
      await end(action, member.id, { reason }).expect(200);

      const res = await end(action, member.id, { reason }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'That membership has already ended',
      });
      expect(await endedEntries()).toHaveLength(1);
    });

    it('refuses a student-only end for staff and for a guest', async () => {
      const member = await memberOf();
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: member.id,
        role: CohortRole.Professor,
      });

      const staff = await end('defer', member.id).expect(409);
      expect(staff.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'Only a student can be deferred',
      });

      await db.execute(sql`delete from cohort_members`);
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: member.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const guest = await end('defer', member.id).expect(409);
      expect(guest.body.error.code).toBe('CONFLICT');
    });

    it('refuses an admin ending their own membership', async () => {
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: adminId,
        role: CohortRole.Mentor,
      });

      const res = await end('remove', adminId).expect(409);
      expect(res.body.error.message).toBe(
        'You cannot end your own membership: ask another admin',
      );
    });

    it('ends only the cohort named, leaving the member live in another', async () => {
      const member = await makeStudent();
      const other = (
        await createCohort({ name: 'Cohort 2', code: 'c2' }).expect(201)
      ).body;
      await db.insert(schema.cohortMembers).values({
        cohortId: other.id,
        userId: member.id,
        role: CohortRole.Mentor,
      });

      await end('graduate', member.id).expect(200);

      const [row] = await db
        .select()
        .from(schema.cohortMembers)
        .where(
          and(
            eq(schema.cohortMembers.cohortId, other.id),
            eq(schema.cohortMembers.userId, member.id),
          ),
        );
      expect(row.leftAt).toBeNull();
    });

    it('requires a reason to dismiss, refusing a blank one', async () => {
      const member = await makeStudent();

      const missing = await end('dismiss', member.id).expect(400);
      expect(missing.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: {
          fields: { reason: expect.stringMatching(/requires a reason/) },
        },
      });

      const blank = await end('dismiss', member.id, { reason: '   ' }).expect(
        400,
      );
      expect(blank.body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('trims the reason and refuses one over the limit', async () => {
      const member = await makeStudent();

      const res = await end('dismiss', member.id, {
        reason: '  Posted the answer  ',
      }).expect(200);
      expect(res.body.reason).toBe('Posted the answer');

      const other = (
        await createCohort({ name: 'Cohort 2', code: 'c2' }).expect(201)
      ).body;
      await db.insert(schema.cohortMembers).values({
        cohortId: other.id,
        userId: member.id,
        role: CohortRole.Mentor,
      });
      await as(adminCookie)
        .post(`/v1/cohorts/${other.id}/members/${member.id}/remove`, {
          reason: 'x'.repeat(501),
        })
        .expect(400);
    });

    it('allows a withdrawal with no reason', async () => {
      const member = await makeStudent();

      const res = await end('withdraw', member.id).expect(200);
      expect(res.body.reason).toBeNull();
    });

    // A refused end never reaches the revocation, so the session the member
    // held keeps working.
    it.each(ACTIONS)(
      'does not revoke sessions when a %s end is refused',
      async (action) => {
        const member = await makeStudent();
        await db
          .update(schema.cohortMembers)
          .set({ leftAt: new Date(), status: StudentStatus.Withdrawn })
          .where(eq(schema.cohortMembers.userId, member.id));

        await as(memberCookie).get('/v1/auth/me').expect(200);
        await end(action, member.id, { reason: reasonFor(action) }).expect(409);
        await as(memberCookie).get('/v1/auth/me').expect(200);
      },
    );

    /**
     * The end, its entry and the revocation are one transaction. A revocation
     * that fails takes the end with it, so nothing is left half done: the
     * member is still on the roster, their session still works, and the
     * admin can try again.
     */
    it.each(ACTIONS)(
      'rolls a %s end back when revocation fails, and takes a retry',
      async (action, status) => {
        const member = await makeStudent();
        const spy = vi
          .spyOn(app.get(SessionIssuer), 'revokeAllSessions')
          .mockRejectedValueOnce(new Error('revocation failed'));

        try {
          const res = await end(action, member.id, {
            reason: reasonFor(action),
          }).expect(500);
          expect(res.body.error.code).toBe('INTERNAL_ERROR');
        } finally {
          spy.mockRestore();
        }

        const [row] = await db
          .select()
          .from(schema.cohortMembers)
          .where(eq(schema.cohortMembers.userId, member.id));
        expect(row.leftAt).toBeNull();
        expect(row.status).toBe(StudentStatus.Active);
        expect(await endedEntries()).toHaveLength(0);
        await as(memberCookie).get('/v1/auth/me').expect(200);

        await end(action, member.id, { reason: reasonFor(action) }).expect(200);
        const [ended] = await db
          .select()
          .from(schema.cohortMembers)
          .where(eq(schema.cohortMembers.userId, member.id));
        expect(ended.status).toBe(status);
        expect(await endedEntries()).toHaveLength(1);
        await as(memberCookie).get('/v1/auth/me').expect(401);
      },
    );

    /**
     * An admin is let in on their role, not on a membership, so ending one
     * takes nothing from them. Revoking would only let any admin sign any
     * other out, a super admin included.
     */
    it('leaves an admin signed in when their membership is removed', async () => {
      const member = await memberOf();
      await db
        .update(users)
        .set({ systemRole: SystemRole.Admin })
        .where(eq(users.id, member.id));
      await db.insert(schema.cohortMembers).values({
        cohortId,
        userId: member.id,
        role: CohortRole.Mentor,
      });

      await end('remove', member.id).expect(200);

      await as(memberCookie).get('/v1/auth/me').expect(200);
    });
  });

  describe('moving a member track', () => {
    let studentId: string;
    let studentCookie: string;
    let otherId: string;
    let cohortId: string;
    let seTrackId: string;
    let seLinkId: string;
    let dataTrackId: string;
    let dataLinkId: string;

    const attach = async (cohort: string, trackId: string) =>
      (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort}/tracks`, { trackId })
          .expect(201)
      ).body;

    const move = (userId: string, body: object, cookie = adminCookie) =>
      as(cookie).patch(`/v1/cohorts/${cohortId}/members/${userId}/track`, body);

    const membershipOf = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.cohortMembers)
        .where(
          and(
            eq(schema.cohortMembers.cohortId, cohortId),
            eq(schema.cohortMembers.userId, id),
          ),
        );
      return row;
    };

    const moveEntries = () =>
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.MemberTrackChanged));

    const rosterRow = async (id: string) => {
      const roster = (
        await as(adminCookie).get(`/v1/cohorts/${cohortId}/members`).expect(200)
      ).body;
      return roster.items.find(
        (item: { user: { id: string } }) => item.user.id === id,
      );
    };

    beforeEach(async () => {
      const se = (
        await createTrack({ name: 'Software Engineering', code: 'se' }).expect(
          201,
        )
      ).body;
      const data = (
        await createTrack({ name: 'Data Science', code: 'ds' }).expect(201)
      ).body;
      const cohort = (await createCohort().expect(201)).body;
      cohortId = cohort.id;
      seTrackId = se.id;
      dataTrackId = data.id;
      seLinkId = (await attach(cohortId, se.id)).id;
      dataLinkId = (await attach(cohortId, data.id)).id;

      const [student] = await db
        .insert(users)
        .values({ email: 'student@campus.local', systemRole: SystemRole.User })
        .returning();
      const [other] = await db
        .insert(users)
        .values({ email: 'other@campus.local', systemRole: SystemRole.User })
        .returning();
      studentId = student.id;
      otherId = other.id;
      studentCookie = await cookieFor(student);
      await db.insert(schema.cohortMembers).values([
        {
          cohortId,
          userId: studentId,
          cohortTrackId: seLinkId,
          role: CohortRole.Student,
          status: StudentStatus.Active,
        },
        {
          cohortId,
          userId: otherId,
          cohortTrackId: seLinkId,
          role: CohortRole.Student,
          status: StudentStatus.Active,
        },
      ]);
    });

    it('moves a student, shows the new track on the roster, and records it', async () => {
      const res = await move(studentId, { trackId: dataTrackId }).expect(200);

      expect(res.body).toEqual({
        id: expect.any(String),
        cohortId,
        userId: studentId,
        role: CohortRole.Student,
        track: { id: dataTrackId, name: 'Data Science', code: 'DS' },
      });
      expect((await membershipOf(studentId)).cohortTrackId).toBe(dataLinkId);

      expect(await rosterRow(studentId)).toMatchObject({
        track: { id: dataTrackId, code: 'DS' },
      });
      expect(await rosterRow(otherId)).toMatchObject({
        track: { id: seTrackId, code: 'SE' },
      });

      expect(await moveEntries()).toEqual([
        expect.objectContaining({
          actorUserId: adminId,
          subjectType: AuditSubjectType.CohortMember,
          subjectId: res.body.id,
          details: {
            cohortId,
            trackId: dataTrackId,
            previousTrackId: seTrackId,
          },
        }),
      ]);
    });

    it('refuses a track this cohort does not run, and records nothing', async () => {
      const loose = (
        await createTrack({ name: 'Product Design', code: 'pd' }).expect(201)
      ).body;

      const res = await move(studentId, { trackId: loose.id }).expect(409);

      expect(res.body.error).toMatchObject({ code: 'CONFLICT' });
      expect((await membershipOf(studentId)).cohortTrackId).toBe(seLinkId);
      expect(await moveEntries()).toHaveLength(0);
      expect(await rosterRow(studentId)).toMatchObject({
        track: { id: seTrackId, code: 'SE' },
      });
    });

    it('refuses a track that another cohort runs', async () => {
      const other = (
        await createCohort({ name: 'Cohort 2', code: 'c2' }).expect(201)
      ).body;
      const shared = (
        await createTrack({ name: 'Product Design', code: 'pd' }).expect(201)
      ).body;
      await attach(other.id, shared.id);

      const res = await move(studentId, { trackId: shared.id }).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        details: { cohortId, trackId: shared.id },
      });
      expect((await membershipOf(studentId)).cohortTrackId).toBe(seLinkId);
      expect(await moveEntries()).toHaveLength(0);
    });

    it('answers 400 for a malformed id and 404 for an absent member', async () => {
      await request(app.getHttpServer())
        .patch(`/v1/cohorts/not-a-uuid/members/${studentId}/track`)
        .set('Cookie', adminCookie)
        .set('Origin', ORIGIN)
        .send({ trackId: dataTrackId })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/v1/cohorts/${cohortId}/members/not-a-uuid/track`)
        .set('Cookie', adminCookie)
        .set('Origin', ORIGIN)
        .send({ trackId: dataTrackId })
        .expect(400);
      await move(MISSING, { trackId: dataTrackId }).expect(404);
    });

    it('answers 400 when the track id is missing or empty', async () => {
      await move(studentId, {}).expect(400);
      await move(studentId, { trackId: '' }).expect(400);
    });

    it('ignores anything but the track id in the body', async () => {
      const before = await membershipOf(studentId);

      await move(studentId, {
        trackId: dataTrackId,
        status: 'dismissed',
        cohortId: MISSING,
        userId: MISSING,
        endDate: '2027-01-01',
      }).expect(200);

      expect(await membershipOf(studentId)).toMatchObject({
        cohortId,
        userId: studentId,
        role: before.role,
        status: before.status,
        leftAt: before.leftAt,
        cohortTrackId: dataLinkId,
      });
    });

    it("leaves the student's existing session working after the move", async () => {
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Cookie', studentCookie)
        .expect(200);

      await move(studentId, { trackId: dataTrackId }).expect(200);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Cookie', studentCookie)
        .expect(200);
    });

    it('refuses a membership that has already ended', async () => {
      await db
        .update(schema.cohortMembers)
        .set({ leftAt: new Date(Date.now() - 60_000) })
        .where(
          and(
            eq(schema.cohortMembers.cohortId, cohortId),
            eq(schema.cohortMembers.userId, studentId),
          ),
        );

      const res = await move(studentId, { trackId: dataTrackId }).expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(await moveEntries()).toHaveLength(0);
    });
  });

  /**
   * None of these tables names who created a row, so the audit entry is the
   * only record of which admin set a cohort up — and the correlation id on
   * it is what leads from the entry back to the request's log lines.
   */
  describe('roster', () => {
    let cohortId: string;

    beforeEach(async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      const link = (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
          .expect(201)
      ).body;
      cohortId = cohort.id;

      const [member] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'member@campus.local'));
      const [left] = await db
        .insert(users)
        .values({ email: 'left@campus.local' })
        .returning();
      await db.insert(schema.cohortMembers).values([
        {
          cohortId,
          userId: member.id,
          cohortTrackId: link.id,
          role: CohortRole.Student,
          status: 'active',
        },
        {
          cohortId,
          userId: left.id,
          role: CohortRole.Mentor,
          leftAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
    });

    const roster = (query = '', cookie = adminCookie) =>
      as(cookie).get(`/v1/cohorts/${cohortId}/members${query}`);

    it('lists the people in the cohort now, by default', async () => {
      const res = await roster().expect(200);

      expect(res.body.meta).toMatchObject({ total: 1 });
      expect(res.body.items[0]).toMatchObject({
        user: { email: 'member@campus.local' },
        role: 'student',
        track: { code: 'SE' },
        state: 'live',
      });
    });

    it.each([
      ['?state=ended', ['left@campus.local']],
      ['?state=all&role=mentor', ['left@campus.local']],
      ['?role=mentor', []],
      ['?state=all', ['left@campus.local', 'member@campus.local']],
    ])('reads %s from the query string', async (query, expected) => {
      const res = await roster(query).expect(200);

      expect(
        res.body.items.map(
          (item: { user: { email: string } }) => item.user.email,
        ),
      ).toEqual(expected);
    });

    it.each([
      ['state', '?state=sometimes'],
      ['role', '?role=janitor'],
      ['trackId', '?trackId=not-a-uuid'],
      ['status', '?status=asleep'],
    ])('rejects a malformed %s', async (field, query) => {
      const res = await roster(query);

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields[field]).toEqual(expect.any(String));
    });

    it('is for admins only', async () => {
      await roster('', memberCookie).expect(403);
      await request(app.getHttpServer())
        .get(`/v1/cohorts/${cohortId}/members`)
        .expect(401);
    });

    it('answers 404 for a missing cohort and 400 for a bad id', async () => {
      await as(adminCookie)
        .get('/v1/cohorts/99999999-9999-4999-8999-999999999999/members')
        .expect(404);
      await as(adminCookie).get('/v1/cohorts/not-a-uuid/members').expect(400);
    });
  });

  describe('audit log', () => {
    const entries = () =>
      db.select().from(auditLog).orderBy(auditLog.createdAt);

    it('records who created a track, and in which request', async () => {
      const response = await createTrack()
        .set('x-correlation-id', 'e2e-track-1')
        .expect(201);

      expect(await entries()).toEqual([
        expect.objectContaining({
          actorUserId: adminId,
          action: AuditAction.TrackCreated,
          subjectType: AuditSubjectType.Track,
          subjectId: response.body.id,
          correlationId: 'e2e-track-1',
          details: { name: 'Software Engineering', code: 'SE' },
        }),
      ]);
    });

    it('records who created a cohort, with what it was created as', async () => {
      const response = await createCohort({
        name: 'Cohort 1',
        code: 'c1',
        startDate: '2026-11-01',
        endDate: '2027-03-01',
      }).expect(201);

      expect(await entries()).toEqual([
        expect.objectContaining({
          actorUserId: adminId,
          action: AuditAction.CohortCreated,
          subjectType: AuditSubjectType.Cohort,
          subjectId: response.body.id,
          // No header sent: the id the API generated, which it also returns.
          correlationId: response.headers['x-correlation-id'],
          details: {
            name: 'Cohort 1',
            code: 'C1',
            status: 'upcoming',
            startDate: '2026-11-01',
            endDate: '2027-03-01',
          },
        }),
      ]);
    });

    it('records who attached a track to a cohort', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      const link = (
        await as(adminCookie)
          .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
          .expect(201)
      ).body;

      expect((await entries()).at(-1)).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.CohortTrackAttached,
        subjectType: AuditSubjectType.CohortTrack,
        subjectId: link.id,
        details: { cohortId: cohort.id, trackId: track.id },
      });
    });

    it('records an invite, with what it offers and not who it went to', async () => {
      const response = await as(adminCookie)
        .post('/v1/invites', {
          email: 'new-admin@campus.local',
          systemRole: SystemRole.Admin,
        })
        .expect(201);

      const [entry] = await entries();
      expect(entry).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.InviteCreated,
        subjectType: AuditSubjectType.Invite,
        subjectId: response.body.id,
        correlationId: response.headers['x-correlation-id'],
        details: { cohortId: null, cohortRole: null, systemRole: 'admin' },
      });
      expect(JSON.stringify(entry.details)).not.toContain('campus.local');
    });

    it('records only the fields a cohort edit actually moved', async () => {
      const cohort = (
        await createCohort({
          name: 'Cohort 1',
          code: 'c1',
          startDate: '2026-11-01',
        }).expect(201)
      ).body;

      await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, {
          name: 'Cohort 1',
          code: 'c2',
          startDate: null,
        })
        .set('x-correlation-id', 'e2e-cohort-edit')
        .expect(200);

      expect((await entries()).at(-1)).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.CohortUpdated,
        subjectType: AuditSubjectType.Cohort,
        subjectId: cohort.id,
        correlationId: 'e2e-cohort-edit',
        details: {
          changes: {
            code: { from: 'C1', to: 'C2' },
            startDate: { from: '2026-11-01', to: null },
          },
        },
      });
    });

    it('records the fields a track edit moved', async () => {
      const track = (
        await createTrack({
          name: 'Software Engineering',
          code: 'se',
          description: 'Backend and frontend',
        }).expect(201)
      ).body;

      await as(adminCookie)
        .patch(`/v1/tracks/${track.id}`, { description: '' })
        .expect(200);

      expect((await entries()).at(-1)).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.TrackUpdated,
        subjectType: AuditSubjectType.Track,
        subjectId: track.id,
        details: {
          changes: { description: { from: 'Backend and frontend', to: null } },
        },
      });
    });

    it('records nothing for an edit that moved nothing', async () => {
      const cohort = (await createCohort().expect(201)).body;
      const track = (await createTrack().expect(201)).body;
      const before = (await entries()).length;

      await as(adminCookie)
        .patch(`/v1/cohorts/${cohort.id}`, { name: 'Cohort 1' })
        .expect(200);
      await as(adminCookie).patch(`/v1/tracks/${track.id}`, {}).expect(200);

      expect(await entries()).toHaveLength(before);
    });

    // The row is gone afterwards, so the entry is the only thing left that
    // says what it was.
    it('records a deleted cohort and track, with what they were', async () => {
      const cohort = (
        await createCohort({
          name: 'Cohort 1',
          code: 'c1',
          startDate: '2026-11-01',
          endDate: '2027-03-01',
        }).expect(201)
      ).body;
      const track = (await createTrack().expect(201)).body;

      await as(adminCookie).del(`/v1/cohorts/${cohort.id}`).expect(204);
      await as(adminCookie).del(`/v1/tracks/${track.id}`).expect(204);

      const [cohortEntry, trackEntry] = (await entries()).slice(-2);
      expect(cohortEntry).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.CohortDeleted,
        subjectType: AuditSubjectType.Cohort,
        subjectId: cohort.id,
        details: {
          name: 'Cohort 1',
          code: 'C1',
          status: 'upcoming',
          startDate: '2026-11-01',
          endDate: '2027-03-01',
        },
      });
      expect(trackEntry).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.TrackDeleted,
        subjectType: AuditSubjectType.Track,
        subjectId: track.id,
        details: {
          name: 'Software Engineering',
          code: 'SE',
          description: null,
        },
      });
    });

    it('records who revoked an invite, and in which request', async () => {
      const invite = (
        await as(adminCookie)
          .post('/v1/invites', {
            email: 'new-admin@campus.local',
            systemRole: SystemRole.Admin,
          })
          .expect(201)
      ).body;

      await as(adminCookie)
        .post(`/v1/invites/${invite.id}/revoke`, {})
        .set('x-correlation-id', 'e2e-revoke')
        .expect(200);

      const entry = (await entries()).at(-1);
      expect(entry).toMatchObject({
        actorUserId: adminId,
        action: AuditAction.InviteRevoked,
        subjectType: AuditSubjectType.Invite,
        subjectId: invite.id,
        correlationId: 'e2e-revoke',
        details: { cohortId: null },
      });
      expect(JSON.stringify(entry?.details)).not.toContain('campus.local');
    });

    it('records nothing for a delete or revoke that was refused', async () => {
      const track = (await createTrack().expect(201)).body;
      const cohort = (await createCohort().expect(201)).body;
      await as(adminCookie)
        .post(`/v1/cohorts/${cohort.id}/tracks`, { trackId: track.id })
        .expect(201);
      const invite = (
        await as(adminCookie)
          .post('/v1/invites', {
            email: 'new-admin@campus.local',
            systemRole: SystemRole.Admin,
          })
          .expect(201)
      ).body;
      await as(adminCookie)
        .post(`/v1/invites/${invite.id}/revoke`, {})
        .expect(200);
      const before = (await entries()).length;

      await as(adminCookie).del(`/v1/cohorts/${cohort.id}`).expect(409);
      await as(adminCookie).del(`/v1/tracks/${track.id}`).expect(409);
      await as(adminCookie)
        .post(`/v1/invites/${invite.id}/revoke`, {})
        .expect(409);

      expect(await entries()).toHaveLength(before);
    });

    // An id too long to store is replaced as the request arrives, not cut
    // down when the entry is written — so the caller, the logs and the entry
    // all end up holding the same one.
    it('gives a request with an over-long correlation id a new one, everywhere', async () => {
      const long = 'c'.repeat(200);

      const response = await createTrack()
        .set('x-correlation-id', long)
        .expect(201);

      const returned = response.headers['x-correlation-id'];
      expect(returned).not.toContain('c'.repeat(64));
      expect(returned.length).toBeLessThanOrEqual(64);
      const [entry] = await entries();
      expect(entry.correlationId).toBe(returned);
    });

    it('stores a correlation id of the longest allowed length whole', async () => {
      const longest = 'c'.repeat(64);

      const response = await createTrack()
        .set('x-correlation-id', longest)
        .expect(201);

      expect(response.headers['x-correlation-id']).toBe(longest);
      const [entry] = await entries();
      expect(entry.correlationId).toBe(longest);
    });

    // The entry and the change share a transaction, so a refusal leaves
    // neither behind.
    it('records nothing for a change that was refused', async () => {
      await createTrack().expect(201);
      await createCohort().expect(201);
      const before = (await entries()).length;

      await createTrack({ name: 'Another', code: 'SE' }).expect(409);
      await createCohort({ name: 'Another', code: 'C1' }).expect(409);
      await as(memberCookie)
        .post('/v1/tracks', { name: 'Design', code: 'ds' })
        .expect(403);

      expect(await entries()).toHaveLength(before);
    });
  });
});
