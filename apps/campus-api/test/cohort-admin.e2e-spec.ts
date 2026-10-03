import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
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
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import { CohortRole } from './../src/modules/cohorts/schema.js';
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
      { userId: user.id, email: user.email, scope: SessionScope.FullAccess },
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
    await app.init();
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

  /**
   * None of these tables names who created a row, so the audit entry is the
   * only record of which admin set a cohort up — and the correlation id on
   * it is what leads from the entry back to the request's log lines.
   */
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

    // The id is whatever the caller put in x-correlation-id, and the column
    // holds 64 characters. An over-long one must not fail the insert, which
    // would take the change down with it.
    it('keeps the start of a correlation id too long to store', async () => {
      const long = 'c'.repeat(200);

      await createTrack().set('x-correlation-id', long).expect(201);

      const [entry] = await entries();
      expect(entry.correlationId).toBe('c'.repeat(64));
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
