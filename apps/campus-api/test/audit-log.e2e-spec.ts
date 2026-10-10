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
  AuditAction,
  AuditSubjectType,
  auditLog,
} from './../src/modules/audit/schema.js';
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

const TRACK = '11111111-1111-4111-8111-111111111111';
const COHORT = '22222222-2222-4222-8222-222222222222';

/**
 * The admin's read of the audit log. The filters themselves are proven
 * against the engine in the service spec; this is the route around them —
 * who may call it, and that a query string reaches the filters as typed.
 */
describe('GET /v1/audit-log (e2e)', () => {
  let app: INestApplication<App>;
  let adminId: string;
  let adminCookie: string;
  let memberCookie: string;

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
    request(app.getHttpServer())
      .get(`/v1/audit-log${query}`)
      .set('Cookie', cookie);

  const actions = async (query: string) =>
    (await list(query).expect(200)).body.items.map(
      (item: { action: string }) => item.action,
    );

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
    await db.execute(sql`truncate audit_log, users cascade`);
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    adminId = admin.id;
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);

    await db.insert(auditLog).values([
      {
        actorUserId: admin.id,
        action: AuditAction.TrackCreated,
        subjectType: AuditSubjectType.Track,
        subjectId: TRACK,
        details: { name: 'Software Engineering', code: 'SE' },
        correlationId: 'corr-1',
        createdAt: new Date('2026-10-01T09:00:00Z'),
      },
      {
        actorUserId: admin.id,
        action: AuditAction.CohortCreated,
        subjectType: AuditSubjectType.Cohort,
        subjectId: COHORT,
        createdAt: new Date('2026-10-02T09:00:00Z'),
      },
      {
        actorUserId: null,
        action: AuditAction.SystemRoleChanged,
        subjectType: AuditSubjectType.User,
        subjectId: admin.id,
        createdAt: new Date('2026-10-03T09:00:00Z'),
      },
    ]);
  });

  it('refuses without a session', async () => {
    await request(app.getHttpServer()).get('/v1/audit-log').expect(401);
  });

  it('refuses a non-admin', async () => {
    const res = await list('', memberCookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lists every entry, newest first', async () => {
    const res = await list().expect(200);

    expect(res.body.meta).toEqual({
      page: 1,
      perPage: 20,
      total: 3,
      totalPages: 1,
    });
    expect(
      res.body.items.map((item: { action: string }) => item.action),
    ).toEqual(['system_role_changed', 'cohort_created', 'track_created']);
    expect(res.body.items[2]).toEqual({
      id: expect.any(String),
      actorUserId: adminId,
      action: 'track_created',
      subjectType: 'track',
      subjectId: TRACK,
      details: { name: 'Software Engineering', code: 'SE' },
      correlationId: 'corr-1',
      createdAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it.each([
    ['?action=cohort_created', ['cohort_created']],
    ['?subjectType=track', ['track_created']],
    [`?subjectType=cohort&subjectId=${COHORT}`, ['cohort_created']],
    ['?from=2026-10-02', ['system_role_changed', 'cohort_created']],
    ['?to=2026-10-02T09:00:00Z', ['track_created']],
    ['?from=2026-10-02T10:00:00%2B01:00&to=2026-10-03', ['cohort_created']],
  ])('filters with %s', async (query, expected) => {
    expect(await actions(query)).toEqual(expected);
  });

  it('filters by the actor', async () => {
    expect(await actions(`?actorUserId=${adminId}`)).toEqual([
      'cohort_created',
      'track_created',
    ]);
  });

  it('paginates', async () => {
    const res = await list('?page=2&perPage=2').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 2, total: 3, totalPages: 2 });
  });

  it.each([
    ['action', '?action=track_renamed'],
    ['actorUserId', '?actorUserId=not-a-uuid'],
    ['subjectType', '?subjectType=space'],
    ['subjectId', '?subjectId=not-a-uuid'],
    ['from', '?from=yesterday'],
    ['from', '?from=2026-02-30'],
    // No zone: it would be read in whatever zone the server runs in.
    ['to', '?to=2026-10-02T09:00:00'],
    ['to', '?from=2026-10-02&to=2026-10-02'],
    ['to', '?from=2026-10-03&to=2026-10-02'],
  ])('rejects a malformed %s (%s)', async (field, query) => {
    const res = await list(query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ARGUMENT');
    expect(res.body.error.details.fields[field]).toEqual(expect.any(String));
  });
});
