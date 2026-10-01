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
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { invites } from './../src/modules/invites/schema.js';
import { SystemRole, UserStatus, users } from './../src/modules/users/schema.js';
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
 * The cookie is httpOnly, so this route is the web app's only way to learn
 * who is signed in and which half of the app they belong in.
 */
describe('GET /v1/auth/me (e2e)', () => {
  let app: INestApplication<App>;
  let member: typeof users.$inferSelect;
  let cohortId: string;

  const cookieFor = async (
    user: typeof users.$inferSelect,
    scope: SessionScope,
    inviteId?: string,
  ) => {
    const { token } = await signSessionToken(
      { userId: user.id, email: user.email, scope, inviteId },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  const me = (cookie?: string) => {
    const req = request(app.getHttpServer()).get('/v1/auth/me');
    return cookie ? req.set('Cookie', cookie) : req;
  };

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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate cohort_members, cohorts, users cascade`);
    [member] = await db
      .insert(users)
      .values({
        email: 'ada@campus.local',
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Ada Lovelace',
      })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    cohortId = cohort.id;
    await db.insert(cohortMembers).values({
      cohortId,
      userId: member.id,
      role: CohortRole.Professor,
    });
  });

  it('describes a full-access session and the place that admits it', async () => {
    const res = await me(await cookieFor(member, SessionScope.FullAccess));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: SessionScope.FullAccess,
      inviteId: null,
      user: {
        id: member.id,
        email: 'ada@campus.local',
        displayName: 'Ada Lovelace',
        systemRole: SystemRole.User,
      },
      membership: { cohortId, role: CohortRole.Professor },
    });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("tells a member about an invite to another cohort they've yet to answer", async () => {
    const [next] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 2', code: 'C2' })
      .returning();
    const [invite] = await db
      .insert(invites)
      .values({
        email: member.email,
        cohortId: next.id,
        cohortRole: CohortRole.Mentor,
        invitedBy: member.id,
        tokenHash: 'hash-member',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    const res = await me(await cookieFor(member, SessionScope.FullAccess));

    expect(res.body).toMatchObject({
      scope: SessionScope.FullAccess,
      inviteId: invite.id,
    });
  });

  it('tells a provisional session which invite it still has to answer', async () => {
    const inviteId = '66666666-6666-4666-8666-666666666666';
    const res = await me(
      await cookieFor(member, SessionScope.Provisional, inviteId),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: SessionScope.Provisional,
      inviteId,
      membership: null,
    });
  });

  it('reads the role from the row, not the token', async () => {
    const cookie = await cookieFor(member, SessionScope.FullAccess);
    await db
      .update(users)
      .set({ systemRole: SystemRole.Admin })
      .where(eq(users.id, member.id));

    const res = await me(cookie);

    expect(res.body.user.systemRole).toBe(SystemRole.Admin);
  });

  it('answers 401 with no session at all', async () => {
    const res = await me();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('answers 401 once the account is suspended', async () => {
    const cookie = await cookieFor(member, SessionScope.FullAccess);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, member.id));

    expect((await me(cookie)).status).toBe(401);
  });
});
