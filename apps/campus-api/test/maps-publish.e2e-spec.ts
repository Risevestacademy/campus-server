import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SessionScope, signSessionToken } from '@campus/session';
import { SPACES_CHANGED_CHANNEL } from '@campus/space-access';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import * as schema from './../src/infra/database/schema/index.js';
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { maps } from './../src/modules/maps/schema.js';
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

describe('POST /v1/maps/:id/publish (e2e)', () => {
  let app: INestApplication<App>;
  let admin: typeof users.$inferSelect;
  let adminCookie: string;
  let memberCookie: string;
  let professorCookie: string;
  let mentorCookie: string;
  let campusId: string;
  let annexId: string;
  let retiredId: string;
  let heard: string[];
  let stopListening: (() => Promise<void>) | undefined;

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

  const publish = (id: string, cookie = adminCookie) =>
    request(app.getHttpServer())
      .post(`/v1/maps/${id}/publish`)
      .set('Cookie', cookie);

  async function boot(): Promise<INestApplication<App>> {
    const booted: INestApplication<App> = (
      await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DRIZZLE)
        .useValue(db)
        .compile()
    ).createNestApplication();
    booted.setGlobalPrefix('v1');
    booted.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    booted.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await booted.listen(0);
    return booted;
  }

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    app = await boot();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, spaces, maps, cohorts, users cascade`,
    );
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    const [professor] = await db
      .insert(users)
      .values({ email: 'professor@campus.local' })
      .returning();
    const [mentor] = await db
      .insert(users)
      .values({ email: 'mentor@campus.local' })
      .returning();
    [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    await db.insert(cohortMembers).values([
      { cohortId: cohort.id, userId: professor.id, role: CohortRole.Professor },
      { cohortId: cohort.id, userId: mentor.id, role: CohortRole.Mentor },
    ]);

    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);
    professorCookie = await cookieFor(professor);
    mentorCookie = await cookieFor(mentor);

    [campusId] = (
      await db
        .insert(maps)
        .values({ key: 'campus', name: 'Campus', isEntry: true })
        .returning({ id: maps.id })
    ).map((map) => map.id);
    [annexId] = (
      await db
        .insert(maps)
        .values({ key: 'annex', name: 'Annex' })
        .returning({ id: maps.id })
    ).map((map) => map.id);
    [retiredId] = (
      await db
        .insert(maps)
        .values({
          key: 'old',
          name: 'Old',
          retiredAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning({ id: maps.id })
    ).map((map) => map.id);

    heard = [];
    stopListening = await db.$client.listen(SPACES_CHANGED_CHANNEL, (payload) =>
      heard.push(payload),
    );
  });

  afterEach(async () => {
    await stopListening?.();
    stopListening = undefined;
  });

  describe('access', () => {
    it('refuses without a session', async () => {
      await request(app.getHttpServer())
        .post(`/v1/maps/${campusId}/publish`)
        .expect(401);
    });

    it.each([
      ['a member', () => memberCookie],
      ['a professor', () => professorCookie],
      ['a mentor', () => mentorCookie],
    ])('refuses %s', async (_, cookie) => {
      const res = await publish(campusId, cookie()).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  it('publishes the entry map and answers with what went live', async () => {
    const res = await publish(campusId).expect(200);

    expect(res.body).toEqual({
      id: campusId,
      key: 'campus',
      publishedAt: expect.any(String),
    });
    const [row] = await db
      .select({ publishedAt: maps.publishedAt })
      .from(maps)
      .where(eq(maps.id, campusId));
    expect(row.publishedAt?.toISOString()).toBe(res.body.publishedAt);

    const written = await db
      .select()
      .from(auditLog)
      .orderBy(asc(auditLog.createdAt));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: AuditAction.MapPublished,
      actorUserId: admin.id,
      subjectId: campusId,
    });
    await vi.waitFor(() => expect(heard).toEqual(['campus']));
    expect(JSON.stringify({ body: res.body, entry: written[0] })).not.toMatch(
      /audit_log|postgres|password|@campus\.local/,
    );
  });

  it('answers 400 for a malformed id, changing nothing', async () => {
    const res = await publish('not-a-uuid').expect(400);

    expect(res.body.error.details.fields).toHaveProperty('id');
    await expect(db.select().from(auditLog)).resolves.toEqual([]);
    expect(heard).toEqual([]);
  });

  it('answers 404 for an unknown map, changing nothing', async () => {
    await publish(MISSING).expect(404);

    await expect(db.select().from(auditLog)).resolves.toEqual([]);
    expect(heard).toEqual([]);
  });

  it('refuses a retired map', async () => {
    const res = await publish(retiredId).expect(409);

    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { mapId: retiredId, key: 'old' },
    });
    await expect(db.select().from(auditLog)).resolves.toEqual([]);
    expect(heard).toEqual([]);
  });

  it('refuses a map that is not the entry map', async () => {
    const res = await publish(annexId).expect(409);

    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { mapId: annexId, key: 'annex' },
    });
    await expect(db.select().from(auditLog)).resolves.toEqual([]);
    expect(heard).toEqual([]);
  });
});
