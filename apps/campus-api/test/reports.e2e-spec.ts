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
import { SessionScope, signSessionToken } from '@campus/contracts';
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
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
 * The routes around the reports, which the service spec proves against the
 * engine: who may call them, the two formats, and what reaches the service.
 */
describe('GET /v1/cohorts/{id}/reports (e2e)', () => {
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

  const report = (path: string, cookie = adminCookie) =>
    request(app.getHttpServer())
      .get(`/v1/cohorts/${c1}/reports/${path}`)
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
    await db.execute(
      sql`truncate audit_log, cohort_members, cohorts, users cascade`,
    );
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({
        email: 'member@campus.local',
        firstName: '=HYPERLINK("x")',
        lastName: 'Mentor',
      })
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);

    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    c1 = cohort.id;
    await db
      .insert(cohortMembers)
      .values({ userId: member.id, cohortId: c1, role: CohortRole.Mentor });
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer())
      .get(`/v1/cohorts/${c1}/reports/membership`)
      .expect(401);
  });

  it.each(['membership', 'attendance'])(
    'refuses a non-admin, even a member of the cohort (%s)',
    async (path) => {
      const res = await report(path, memberCookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    },
  );

  it('gives the membership report as JSON, not to be cached', async () => {
    const res = await report('membership').expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.cohort).toEqual({ id: c1, code: 'C1', name: 'Cohort 1' });
    expect(res.body.rows).toEqual([
      expect.objectContaining({
        email: 'member@campus.local',
        role: 'mentor',
        state: 'live',
      }),
    ]);
  });

  it('downloads the membership report as CSV and records it', async () => {
    const res = await report('membership?format=csv&role=mentor').expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="C1-membership-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const [header, record] = res.text.replace(/^﻿/, '').split('\r\n');
    expect(header.startsWith('email,first_name,last_name')).toBe(true);
    // A name a spreadsheet would run is written as text.
    expect(record).toContain(`member@campus.local,"'=HYPERLINK(""x"")",Mentor`);

    const entries = await db.select().from(auditLog);
    expect(entries).toEqual([
      expect.objectContaining({
        action: AuditAction.ReportExported,
        subjectId: c1,
        details: expect.objectContaining({
          report: 'membership',
          role: 'mentor',
          rows: 1,
        }),
      }),
    ]);
  });

  it('gives the attendance report in both formats', async () => {
    const json = await report(
      'attendance?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z',
    ).expect(200);
    expect(json.body).toMatchObject({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
      rows: [],
    });

    const csv = await report('attendance?format=csv').expect(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.text.replace(/^﻿/, '')).toMatch(/^email,.*,percentage,/);
  });

  it.each([
    'membership?format=xlsx',
    'membership?state=gone',
    'attendance?from=yesterday',
    'attendance?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z',
  ])('rejects %s', async (path) => {
    expect((await report(path)).status).toBe(400);
  });

  it('answers 404 for a cohort that does not exist', async () => {
    await request(app.getHttpServer())
      .get(
        '/v1/cohorts/99999999-9999-4999-8999-999999999999/reports/membership',
      )
      .set('Cookie', adminCookie)
      .expect(404);
  });
});
