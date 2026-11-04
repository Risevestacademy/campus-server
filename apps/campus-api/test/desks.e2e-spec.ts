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
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { desks } from './../src/modules/desks/schema.js';
import { maps } from './../src/modules/maps/schema.js';
import { users } from './../src/modules/users/schema.js';
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
  await app.listen(0);
  return app;
}

/**
 * The desk routes from the outside: sessions, parameters, status codes and
 * the shape of a desk. Who may do what is proven in the service spec.
 */
describe('desk routes (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let adaToken: string;
  let guestToken: string;

  const tokenFor = async (user: typeof users.$inferSelect) =>
    (await app.get(SessionIssuer).issueFullAccess(user, { endsAt: null }))
      .token;

  const as = (token: string) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    app = await boot();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate refresh_tokens, desk_claims, desks, maps, cohort_members, cohorts, users cascade`,
    );
    const [map] = await db
      .insert(maps)
      .values({ key: 'campus', name: 'Campus', isEntry: true })
      .returning();
    await db.insert(desks).values({ mapId: map.id, key: 'desk_a' });
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    cohortId = cohort.id;
    const [ada, guest] = await db
      .insert(users)
      .values([
        { email: 'ada@campus.local', displayName: 'Ada' },
        { email: 'guest@campus.local' },
      ])
      .returning();
    await db.insert(cohortMembers).values([
      { cohortId, userId: ada.id, role: CohortRole.Mentor },
      {
        cohortId,
        userId: guest.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    adaToken = await tokenFor(ada);
    guestToken = await tokenFor(guest);
  });

  it.each([
    ['get', '/desks'],
    ['post', '/desks/desk_a/claim'],
    ['post', '/desks/desk_a/release'],
  ] as const)('refuses %s %s without a session', async (method, path) => {
    await request(app.getHttpServer())
      [method](`/v1/cohorts/${cohortId}${path}`)
      .expect(401);
  });

  it('refuses a cohort id that is not a UUID, and a key too long', async () => {
    await as(adaToken).get('/v1/cohorts/nope/desks').expect(400);
    await as(adaToken)
      .post(`/v1/cohorts/${cohortId}/desks/${'k'.repeat(65)}/claim`)
      .expect(400);
  });

  it('claims, lists and lets go of a desk', async () => {
    const claimed = await as(adaToken)
      .post(`/v1/cohorts/${cohortId}/desks/desk_a/claim`)
      .expect(200);
    expect(claimed.body).toEqual({
      key: 'desk_a',
      mapKey: 'campus',
      holder: { id: expect.any(String), displayName: 'Ada' },
      claimedAt: expect.any(String),
    });

    const listed = await as(guestToken)
      .get(`/v1/cohorts/${cohortId}/desks`)
      .expect(200);
    expect(listed.body).toEqual([claimed.body]);

    const released = await as(adaToken)
      .post(`/v1/cohorts/${cohortId}/desks/desk_a/release`)
      .expect(200);
    expect(released.body).toMatchObject({ holder: null, claimedAt: null });
  });

  it('answers 403 to a guest claiming, 404 to an unknown desk, 200 to letting go of a free one', async () => {
    await as(guestToken)
      .post(`/v1/cohorts/${cohortId}/desks/desk_a/claim`)
      .expect(403);
    await as(adaToken)
      .post(`/v1/cohorts/${cohortId}/desks/nowhere/claim`)
      .expect(404);
    const free = await as(adaToken)
      .post(`/v1/cohorts/${cohortId}/desks/desk_a/release`)
      .expect(200);
    expect(free.body).toMatchObject({ holder: null });
  });
});
