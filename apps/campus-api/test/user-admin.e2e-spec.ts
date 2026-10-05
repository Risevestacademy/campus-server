import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
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
const db = drizzle(new PGlite(), { schema });

/**
 * The admin's list of who has an account. The filters themselves are proven
 * against the engine in the service spec; this is the route around them —
 * who may call it, and that a query string reaches the filters as typed.
 */
describe('GET /v1/users (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let cohortId: string;
  let trackId: string;

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

  const list = (query = '', cookie = adminCookie) =>
    request(app.getHttpServer()).get(`/v1/users${query}`).set('Cookie', cookie);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
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
    // Listening once, rather than app.init(): supertest otherwise opens and
    // closes a server on a new port for every request, and with the files
    // running in parallel those ports get handed between workers mid-request.
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
    const [student] = await db
      .insert(users)
      .values({
        email: 'student@campus.local',
        firstName: 'Ada',
        providerId: 'google-subject-1',
      })
      .returning();
    const [mentor] = await db
      .insert(users)
      .values({ email: 'mentor@campus.local' })
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(student);

    const [track] = await db
      .insert(tracks)
      .values({ name: 'Software Engineering', code: 'SE' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    const [link] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();
    cohortId = cohort.id;
    trackId = track.id;

    await db.insert(cohortMembers).values([
      {
        userId: student.id,
        cohortId,
        cohortTrackId: link.id,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      },
      { userId: mentor.id, cohortId, role: CohortRole.Mentor },
    ]);
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer()).get('/v1/users').expect(401);
  });

  it('refuses a non-admin', async () => {
    const res = await list('', memberCookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lists everyone, with their memberships and no Google subject', async () => {
    const res = await list().expect(200);

    expect(res.body.meta).toEqual({
      page: 1,
      perPage: 20,
      total: 3,
      totalPages: 1,
    });
    const student = res.body.items.find(
      (item: { email: string }) => item.email === 'student@campus.local',
    );
    expect(student).toMatchObject({
      firstName: 'Ada',
      systemRole: 'user',
      status: 'active',
      memberships: [
        {
          cohort: { id: cohortId, name: 'Cohort 1', code: 'C1' },
          track: { id: trackId, name: 'Software Engineering', code: 'SE' },
          role: 'student',
          status: 'active',
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('google-subject-1');
  });

  it.each([
    ['?systemRole=admin', ['admin@campus.local']],
    ['?cohortRole=mentor', ['mentor@campus.local']],
    ['?search=ada', ['student@campus.local']],
    // Postgres refuses NUL in text, so one that got through would be a 500.
    ['?search=a%00da', ['student@campus.local']],
    ['?status=suspended', []],
  ])('filters with %s', async (query, expected) => {
    const res = await list(query).expect(200);

    expect(res.body.items.map((item: { email: string }) => item.email)).toEqual(
      expected,
    );
  });

  it('filters by cohort, by track, and by both', async () => {
    const emails = async (query: string) =>
      (await list(query).expect(200)).body.items
        .map((item: { email: string }) => item.email)
        .sort();

    expect(await emails(`?cohortId=${cohortId}`)).toEqual([
      'mentor@campus.local',
      'student@campus.local',
    ]);
    expect(await emails(`?trackId=${trackId}`)).toEqual([
      'student@campus.local',
    ]);
    expect(
      await emails(
        `?cohortId=${cohortId}&trackId=${trackId}&cohortRole=student`,
      ),
    ).toEqual(['student@campus.local']);
  });

  it('paginates', async () => {
    const res = await list('?page=2&perPage=2').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 2, total: 3, totalPages: 2 });
  });

  it.each([
    ['cohortId', '?cohortId=not-a-uuid'],
    ['trackId', '?trackId=not-a-uuid'],
    ['cohortRole', '?cohortRole=janitor'],
    ['systemRole', '?systemRole=root'],
    ['status', '?status=asleep'],
  ])('rejects a malformed %s', async (field, query) => {
    const res = await list(query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    expect(res.body.error.details.fields[field]).toEqual(expect.any(String));
  });
});
