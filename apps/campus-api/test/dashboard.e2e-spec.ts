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
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
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
 * The route around the dashboard's figures, which the service spec proves
 * against the engine: who may call it, and that `cohortId` reaches it.
 */
describe('GET /v1/dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let c1: string;

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

  const figures = (query = '', cookie = adminCookie) =>
    request(app.getHttpServer())
      .get(`/v1/dashboard${query}`)
      .set('Cookie', cookie);

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
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate cohort_members, cohorts, users cascade`);
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);

    const [cohort1, cohort2] = await db
      .insert(cohorts)
      .values([
        { name: 'Cohort 1', code: 'C1' },
        { name: 'Cohort 2', code: 'C2' },
      ])
      .returning();
    c1 = cohort1.id;
    await db.insert(cohortMembers).values([
      { userId: member.id, cohortId: cohort1.id, role: CohortRole.Mentor },
      { userId: member.id, cohortId: cohort2.id, role: CohortRole.Professor },
    ]);
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer()).get('/v1/dashboard').expect(401);
  });

  it('refuses a non-admin', async () => {
    const res = await figures('', memberCookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('gives the campus’s figures', async () => {
    const res = await figures().expect(200);

    expect(res.body).toEqual({
      members: {
        total: 1,
        byRole: { student: 0, professor: 1, mentor: 1, guest: 0 },
      },
      pendingInvites: 0,
    });
  });

  it('gives one cohort’s figures', async () => {
    const res = await figures(`?cohortId=${c1}`).expect(200);

    expect(res.body.members.byRole).toEqual({
      student: 0,
      professor: 0,
      mentor: 1,
      guest: 0,
    });
  });

  it('rejects a cohortId that is not a UUID', async () => {
    const res = await figures('?cohortId=cohort-1');

    expect(res.status).toBe(400);
  });

  it('answers 404 for a cohort that does not exist', async () => {
    const res = await figures('?cohortId=99999999-9999-4999-8999-999999999999');

    expect(res.status).toBe(404);
  });
});
