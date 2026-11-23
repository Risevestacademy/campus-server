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
import { GoogleOAuthService } from './../src/modules/auth/google-oauth.service.js';
import { CohortRole, CohortStatus } from './../src/modules/cohorts/schema.js';
import {
  SystemRole,
  UserStatus,
  users,
} from './../src/modules/users/schema.js';
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
/** Stands in for Google: says whose id_token it was handed. */
const google = { verifyIdToken: vi.fn() };

/** Deleting an account, from the outside: the route, its guard, and the person locked out. */
describe('DELETE /v1/users/:id (e2e)', () => {
  let app: INestApplication<App>;
  let root: typeof users.$inferSelect;
  let admin: typeof users.$inferSelect;
  let member: typeof users.$inferSelect;
  let rootToken: string;
  let adminToken: string;
  let memberToken: string;

  // Through the real sign-in, so each token is the one this account would
  // be handed, and the refusal after a suspension is the one a person at a
  // keyboard would meet.
  const signIn = async (email: string) => {
    google.verifyIdToken.mockResolvedValueOnce({
      subject: `google-${email}`,
      email,
      emailVerified: true,
      firstName: null,
      lastName: null,
      displayName: null,
      pictureUrl: null,
    });
    const res = await request(app.getHttpServer())
      .post('/v1/auth/google/token')
      .send({ idToken: `id-token-for-${email}` });
    return res;
  };
  const tokenFor = async (user: typeof users.$inferSelect) => {
    const res = await signIn(user.email);
    expect(res.status).toBe(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const me = (token: string) =>
    request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

  const rowOf = async (userId: string) => {
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    return row;
  };
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(GoogleOAuthService)
      .useValue(google)
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
      sql`truncate audit_log, refresh_tokens, invites, cohort_members, cohorts, users cascade`,
    );
    [root, admin, member] = await db
      .insert(users)
      .values([
        { email: 'root@campus.local', systemRole: SystemRole.SuperAdmin },
        { email: 'admin@campus.local', systemRole: SystemRole.Admin },
        { email: 'member@campus.local', systemRole: SystemRole.User },
      ])
      .returning();
    // The member is in a cohort, which is what gives an ordinary user a
    // full session; the two admins are let in on their role alone.
    const [cohort] = await db
      .insert(schema.cohorts)
      .values({ name: 'Cohort 1', code: 'C1', status: CohortStatus.Active })
      .returning();
    await db.insert(schema.cohortMembers).values({
      cohortId: cohort.id,
      userId: member.id,
      role: CohortRole.Mentor,
    });
    rootToken = await tokenFor(root);
    adminToken = await tokenFor(admin);
    memberToken = await tokenFor(member);
  });

  const remove = (token: string, userId: string) =>
    request(app.getHttpServer())
      .delete(`/v1/users/${userId}`)
      .set('Authorization', `Bearer ${token}`);

  it('refuses without a session, and to somebody who is not an admin', async () => {
    await request(app.getHttpServer())
      .delete(`/v1/users/${member.id}`)
      .expect(401);
    await remove(memberToken, admin.id).expect(403);
  });

  it('deletes the account, and its very next request is refused', async () => {
    await me(memberToken).expect(200);

    await remove(adminToken, member.id).expect(204);

    await me(memberToken).expect(401);
    const row = await rowOf(member.id);
    expect(row.status).toBe(UserStatus.Deleted);
    expect(row.email).not.toBe('member@campus.local');
  });

  it('treats the same Google account afterwards as somebody never seen', async () => {
    await remove(adminToken, member.id).expect(204);

    const returning = await signIn('member@campus.local');
    const stranger = await signIn('stranger@campus.local');

    expect(returning.status).toBe(stranger.status);
    const row = await rowOf(member.id);
    expect(row.status).toBe(UserStatus.Deleted);
    expect(row.lastLoginAt).toBeNull();
  });

  it('refuses a plain admin deleting a super admin, and anybody deleting themselves', async () => {
    await remove(adminToken, root.id).expect(403);
    await remove(adminToken, admin.id).expect(409);
    await remove(rootToken, admin.id).expect(204);
  });

  it('answers 409 the second time', async () => {
    await remove(adminToken, member.id).expect(204);
    await remove(adminToken, member.id).expect(409);
  });

  it('refuses an id that is not a UUID', async () => {
    await remove(adminToken, 'not-a-uuid').expect(400);
  });
});
