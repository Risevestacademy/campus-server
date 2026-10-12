import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

/**
 * Suspending and reinstating an account, from the outside. What the change
 * writes is proven in the service spec; what only shows here is that it is
 * real: the suspended person's very next request is refused, they cannot
 * sign in until somebody reinstates them, and a reinstatement hands back
 * access rather than the sessions the suspension took.
 */
describe('POST /v1/users/:id/suspend (e2e)', () => {
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
      avatarUrl: null,
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

  const suspend = (token: string, userId: string, body?: object) => {
    const req = request(app.getHttpServer())
      .post(`/v1/users/${userId}/suspend`)
      .set('Authorization', `Bearer ${token}`);
    // A body is optional: an admin may suspend for something that needs no
    // writing down, so the request goes out with nothing at all.
    return body === undefined ? req : req.send(body);
  };

  const reinstate = (token: string, userId: string) =>
    request(app.getHttpServer())
      .post(`/v1/users/${userId}/reinstate`)
      .set('Authorization', `Bearer ${token}`);

  const rowOf = async (userId: string) => {
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    return row;
  };
  const entries = async () => {
    const rows = await db
      .select()
      .from(schema.auditLog)
      .orderBy(schema.auditLog.createdAt, schema.auditLog.id);
    return rows;
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

  it('refuses without a session, and to somebody who is not an admin', async () => {
    await request(app.getHttpServer())
      .post(`/v1/users/${member.id}/suspend`)
      .send({ reason: 'because' })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/v1/users/${member.id}/reinstate`)
      .expect(401);

    await suspend(memberToken, admin.id, {}).expect(403);
    await reinstate(memberToken, admin.id).expect(403);
  });

  it('suspends an account, and its very next request is refused', async () => {
    await me(memberToken).expect(200);

    const res = await suspend(adminToken, member.id, {
      reason: 'Posted the answer to a live assessment',
    }).expect(200);

    expect(res.body).toEqual({
      id: member.id,
      email: 'member@campus.local',
      status: UserStatus.Suspended,
    });
    await me(memberToken).expect(401);
    // The suspension reaches what it already holds as well: the epoch the
    // tokens were signed with no longer matches the row, which is also what
    // world reads when it drops the socket on its next heartbeat.
    const row = await rowOf(member.id);
    expect(row.status).toBe(UserStatus.Suspended);
    expect(row.sessionEpoch).toBe(1);
  });

  it('records the reason in the audit log, and nowhere in the answer', async () => {
    const res = await suspend(adminToken, member.id, {
      reason: '  Posted the answer to a live assessment  ',
    }).expect(200);

    expect(res.body).toEqual({
      id: member.id,
      email: 'member@campus.local',
      status: UserStatus.Suspended,
    });
    // The suspension names its author on the row, which is what lets
    // reinstate decide who may lift it.
    const row = await rowOf(member.id);
    expect(row.status).toBe(UserStatus.Suspended);
    expect(row.suspendedBy).toBe(admin.id);
    expect(row.suspendedByRole).toBe(SystemRole.Admin);
    expect(await entries()).toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        subjectType: 'user',
        subjectId: member.id,
        details: {
          reason: 'Posted the answer to a live assessment',
          actorRole: SystemRole.Admin,
        },
      }),
    ]);
  });

  it('suspends with no reason when the request carries no body', async () => {
    await suspend(adminToken, member.id).expect(200);

    expect(await entries()).toEqual([
      expect.objectContaining({
        details: { reason: null, actorRole: SystemRole.Admin },
      }),
    ]);
  });

  it('refuses the sign-in of a suspended account until it is reinstated', async () => {
    await suspend(adminToken, member.id).expect(200);

    const refused = await signIn('member@campus.local');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const back = await reinstate(adminToken, member.id).expect(200);
    expect(back.body).toEqual({
      id: member.id,
      email: 'member@campus.local',
      status: UserStatus.Active,
    });

    const again = await signIn('member@campus.local');
    expect(again.status).toBe(200);
    expect((again.body as { scope: string }).scope).toBe('full_access');
    // Access is handed back, not the sessions: the token issued before the
    // suspension stays refused, so the person signs in again on each device.
    await me(memberToken).expect(401);
    await me((again.body as { accessToken: string }).accessToken).expect(200);
  });

  it('refuses an admin suspending their own account', async () => {
    const res = await suspend(adminToken, admin.id, { reason: 'oops' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe(
      'You cannot suspend your own account: ask another admin',
    );
    expect((await rowOf(admin.id)).status).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
    await me(adminToken).expect(200);
  });

  it('refuses an account that is already suspended', async () => {
    await suspend(adminToken, member.id, { reason: 'first' }).expect(200);

    const res = await suspend(adminToken, member.id, { reason: 'again' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This account is already suspended');
    expect(await entries()).toHaveLength(1);
  });

  // The service checks the caller's status again, under the lock, for a
  // request that was already under way when the suspension landed. Over
  // HTTP the guard gets there first with a 401, which is what this shows;
  // the service's own refusal is in the service spec, where the two can be
  // made to cross.
  it('refuses a suspended admin at the guard, before the route runs', async () => {
    await suspend(rootToken, admin.id).expect(200);

    const res = await suspend(adminToken, member.id, { reason: 'too late' });

    expect(res.status).toBe(401);
    expect(await entries()).toHaveLength(1);
  });

  it('refuses to reinstate an account that is not suspended', async () => {
    const res = await reinstate(adminToken, member.id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This account is not suspended');
    expect((await rowOf(member.id)).status).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);
  });

  it('lets one admin suspend another, and a super admin suspend an admin', async () => {
    const [other] = await db
      .insert(users)
      .values({ email: 'other@campus.local', systemRole: SystemRole.Admin })
      .returning();

    await suspend(adminToken, other.id).expect(200);
    await suspend(rootToken, admin.id).expect(200);

    expect((await rowOf(other.id)).status).toBe(UserStatus.Suspended);
    expect((await rowOf(admin.id)).status).toBe(UserStatus.Suspended);
    expect((await rowOf(root.id)).status).toBe(UserStatus.Active);
  });

  it('refuses a plain admin suspending a super admin, and lets a super admin suspend one', async () => {
    const [otherRoot] = await db
      .insert(users)
      .values({
        email: 'root2@campus.local',
        systemRole: SystemRole.SuperAdmin,
      })
      .returning();

    const refused = await suspend(adminToken, root.id, { reason: 'because' });

    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(refused.body.error.message).toBe(
      'A super admin is required to suspend a super admin',
    );
    expect((await rowOf(root.id)).status).toBe(UserStatus.Active);
    expect(await entries()).toEqual([]);

    // A super admin may suspend anybody but themselves, super admins
    // included: a compromised root account still has a way out.
    await suspend(rootToken, otherRoot.id).expect(200);

    expect((await rowOf(otherRoot.id)).status).toBe(UserStatus.Suspended);
    expect(await entries()).toHaveLength(1);
  });

  it('refuses a plain admin lifting a suspension a super admin made, and lets a super admin lift it', async () => {
    await suspend(rootToken, member.id, {
      reason: 'a super admin decided',
    }).expect(200);

    const refused = await reinstate(adminToken, member.id);

    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(refused.body.error.message).toBe(
      'A super admin is required to lift this suspension',
    );
    expect((await rowOf(member.id)).status).toBe(UserStatus.Suspended);
    expect(await entries()).toHaveLength(1);

    const back = await reinstate(rootToken, member.id).expect(200);

    expect(back.body.status).toBe(UserStatus.Active);
    expect(await entries()).toHaveLength(2);
    expect((await entries())[1]).toMatchObject({
      actorUserId: root.id,
      details: {
        actorRole: SystemRole.SuperAdmin,
        suspendedBy: root.id,
        suspendedByRole: SystemRole.SuperAdmin,
      },
    });
  });

  it('lets another plain admin lift a suspension a plain admin made', async () => {
    const [other] = await db
      .insert(users)
      .values({ email: 'other@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const otherToken = await tokenFor(other);
    await suspend(adminToken, member.id, { reason: 'an admin decided' }).expect(
      200,
    );

    const back = await reinstate(otherToken, member.id).expect(200);

    expect(back.body.status).toBe(UserStatus.Active);
    expect((await rowOf(member.id)).suspendedBy).toBeNull();
    expect((await entries())[1]).toMatchObject({
      actorUserId: other.id,
      details: {
        actorRole: SystemRole.Admin,
        suspendedBy: admin.id,
        suspendedByRole: SystemRole.Admin,
      },
    });
  });

  it('answers 404 for a missing user and 400 for a bad id', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';

    await suspend(adminToken, missing).expect(404);
    await reinstate(adminToken, missing).expect(404);
    await suspend(adminToken, 'not-a-uuid').expect(400);
    await reinstate(adminToken, 'not-a-uuid').expect(400);
  });

  it('rejects a reason that is not a short string', async () => {
    const tooLong = 'x'.repeat(501);
    const asNumber = { reason: 42 };

    for (const body of [{ reason: tooLong }, asNumber]) {
      const res = await suspend(adminToken, member.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.fields.reason).toEqual(expect.any(String));
    }
    expect(await entries()).toEqual([]);
  });

  // Both routes are part of the document the web app generates its client
  // from, so a route that is missing from it, or marked public, is a
  // contract bug even though the runtime refuses it. The 403 is two refusals
  // on these routes — not an admin, and an admin of the wrong rank — so
  // both have to be in the document, not just the first.
  it('is in the OpenAPI document, needing a session', async () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const paths = document.paths as Record<
      string,
      Record<
        string,
        { security?: unknown; responses?: Record<string, unknown> }
      >
    >;

    const rankRules = {
      '/v1/users/{id}/suspend':
        'A super admin is required to suspend a super admin',
      '/v1/users/{id}/reinstate':
        'A super admin is required to lift this suspension',
    };

    for (const path of Object.keys(rankRules)) {
      expect(paths[path]).toBeDefined();
      expect(paths[path].post).toBeDefined();
      expect(paths[path].post.security).toEqual([{ bearer: [] }]);

      const forbidden = JSON.stringify(paths[path].post.responses?.['403']);
      expect(forbidden).toContain('Admin role required');
      expect(forbidden).toContain(rankRules[path as keyof typeof rankRules]);
    }
  });
});
