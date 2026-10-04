import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
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
const db = drizzle(new PGlite(), { schema });
async function boot() {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE)
    .useValue(db)
    .compile();
  const app: INestApplication<App> = moduleFixture.createNestApplication();
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
  return app;
}

/**
 * The profile routes from the outside: who may call them, and what a request
 * body is turned into before it reaches the service. The rule for who sees
 * whose card is proven in the service spec.
 */
describe('profile routes (e2e)', () => {
  let app: INestApplication<App>;
  let ada: typeof users.$inferSelect;
  let grace: typeof users.$inferSelect;
  let adaToken: string;
  let graceToken: string;

  // Real tokens from the real issuer, so these tests hold whatever a
  // session token is made to carry.
  const tokenFor = async (user: typeof users.$inferSelect) =>
    (await app.get(SessionIssuer).issueFullAccess(user, { endsAt: null }))
      .token;

  const as = (token: string) => {
    const call = (method: 'get' | 'patch') => (path: string, body?: object) => {
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${token}`);
      return body ? req.send(body) : req;
    };
    return {
      get: call('get'),
      patch: call('patch'),
    };
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    app = await boot();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate refresh_tokens, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

    [ada] = await db
      .insert(users)
      .values({ email: 'ada@campus.local', firstName: 'Ada' })
      .returning();
    [grace] = await db
      .insert(users)
      .values({ email: 'grace@campus.local' })
      .returning();
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
    await db.insert(cohortMembers).values({
      userId: ada.id,
      cohortId: cohort.id,
      cohortTrackId: link.id,
      role: CohortRole.Student,
      status: StudentStatus.Active,
    });

    adaToken = await tokenFor(ada);
    graceToken = await tokenFor(grace);
  });

  describe('access', () => {
    it.each([
      ['get', '/v1/users/me'],
      ['patch', '/v1/users/me'],
      ['get', '/v1/users/11111111-1111-4111-8111-111111111111/profile'],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    // Both controllers sit under /v1/users. The admin list must stay the
    // admin's, and `me` must not be read as somebody's id.
    it('keeps the admin list for admins while `me` is open to members', async () => {
      await as(adaToken).get('/v1/users').expect(403);
      await as(adaToken).get('/v1/users/me').expect(200);
    });
  });

  describe('own profile', () => {
    it('reads it', async () => {
      const res = await as(adaToken).get('/v1/users/me').expect(200);

      expect(res.body).toMatchObject({
        id: ada.id,
        email: 'ada@campus.local',
        firstName: 'Ada',
        phone: null,
        memberships: [{ role: 'student', cohort: { code: 'C1' } }],
      });
    });

    it('updates the fields sent, trimmed', async () => {
      const res = await as(adaToken)
        .patch('/v1/users/me', {
          displayName: '  Ada L.  ',
          phone: '+234 801 234 5678',
        })
        .expect(200);

      expect(res.body).toMatchObject({
        firstName: 'Ada',
        displayName: 'Ada L.',
        phone: '+234 801 234 5678',
      });
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
      ['only spaces', '   '],
    ])('clears a field sent as %s', async (_label, value) => {
      const res = await as(adaToken)
        .patch('/v1/users/me', { firstName: value })
        .expect(200);

      expect(res.body.firstName).toBeNull();
    });

    // Postgres refuses NUL in text, so one that got through would be a 500.
    it('drops a NUL character', async () => {
      const res = await as(adaToken)
        .patch('/v1/users/me', { bio: 'Hel\u0000lo' })
        .expect(200);

      expect(res.body.bio).toBe('Hello');
    });

    it.each([
      ['phone', { phone: 'call me' }],
      ['phone', { phone: '+1' }],
      ['bio', { bio: 'x'.repeat(501) }],
      ['firstName', { firstName: 'x'.repeat(81) }],
      ['displayName', { displayName: 42 }],
    ])('rejects a bad %s', async (field, body) => {
      const res = await as(adaToken).patch('/v1/users/me', body);

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields[field]).toEqual(expect.any(String));
    });

    it('ignores fields that are not the person’s to change', async () => {
      await as(adaToken)
        .patch('/v1/users/me', {
          firstName: 'Ada',
          email: 'admin@campus.local',
          systemRole: 'admin',
          status: 'suspended',
          avatarUrl: 'https://evil.example/x.png',
        })
        .expect(200);

      const [row] = await db.select().from(users).where(eq(users.id, ada.id));
      expect(row).toMatchObject({
        email: 'ada@campus.local',
        systemRole: SystemRole.User,
        status: 'active',
        avatarUrl: null,
      });
    });
  });

  describe('profile card', () => {
    it('404s a member who shares no cohort with them', async () => {
      const res = await as(graceToken).get(`/v1/users/${ada.id}/profile`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('shows the card to a classmate, without the phone', async () => {
      const [membership] = await db.select().from(cohortMembers);
      await db.insert(cohortMembers).values({
        userId: grace.id,
        cohortId: membership.cohortId,
        role: CohortRole.Mentor,
      });
      await db
        .update(users)
        .set({ phone: '+234 801 234 5678' })
        .where(eq(users.id, ada.id));

      const res = await as(graceToken)
        .get(`/v1/users/${ada.id}/profile`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: ada.id,
        email: 'ada@campus.local',
        memberships: [{ role: 'student', cohort: { code: 'C1' } }],
      });
      expect(JSON.stringify(res.body)).not.toContain('801 234');
    });

    it('rejects an id that is not a UUID', async () => {
      await as(adaToken).get('/v1/users/not-a-uuid/profile').expect(400);
    });
  });
});
