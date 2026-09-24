import { PGlite } from '@electric-sql/pglite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import * as schema from './../src/infra/database/schema/index.js';
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import {
  SessionScope,
  signSessionToken,
} from './../src/modules/auth/session-token.js';
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

// With the schema, so drizzle's query API (used by InvitesService) exists.
const db = drizzle(new PGlite(), { schema });

/**
 * The session is what makes an authenticated route reachable at all: before
 * it existed, nothing populated req.user and every admin route answered 401
 * no matter who was asking.
 */
describe('session access (e2e)', () => {
  let app: INestApplication<App>;

  const session = async (
    userId: string,
    email: string,
    scope = SessionScope.FullAccess,
  ) => {
    const { token } = await signSessionToken(
      { userId, email, scope, inviteId: scope === SessionScope.Provisional ? 'invite-1' : undefined },
      { secret: SECRET, ttlMinutes: 30 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  const createInvite = (cookie?: string) => {
    const req = request(app.getHttpServer())
      .post('/v1/invites')
      .send({ email: 'newcomer@campus.local' });
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

  beforeEach(async () => {
    await db.execute(sql`truncate invites, users cascade`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lets an admin holding a session create an invite', async () => {
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();

    const response = await createInvite(await session(admin.id, admin.email));

    expect(response.status).toBe(201);
    expect(response.body.email).toBe('newcomer@campus.local');
  });

  it('refuses a caller with no session', async () => {
    const response = await createInvite();

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses an ordinary member, who is authenticated but not an admin', async () => {
    const [member] = await db
      .insert(users)
      .values({ email: 'ada@campus.local' })
      .returning();

    const response = await createInvite(await session(member.id, member.email));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  /** Half-onboarded is not a licence to run admin routes. */
  it('refuses a provisional session even when the account is an admin', async () => {
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();

    const response = await createInvite(
      await session(admin.id, admin.email, SessionScope.Provisional),
    );

    expect(response.status).toBe(401);
  });

  it('refuses a token this deployment did not sign', async () => {
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();

    const { token } = await signSessionToken(
      {
        userId: admin.id,
        email: admin.email,
        scope: SessionScope.FullAccess,
      },
      { secret: 'a-different-secret-of-at-least-32-characters', ttlMinutes: 30 },
    );

    const response = await createInvite(`${SESSION_COOKIE}=${token}`);

    expect(response.status).toBe(401);
  });

  /**
   * The role is read from the row, so revoking admin takes effect on the next
   * request rather than whenever the session happens to run out.
   */
  it('stops honouring a session once the account is demoted', async () => {
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const cookie = await session(admin.id, admin.email);

    expect((await createInvite(cookie)).status).toBe(201);

    await db.execute(sql`update users set system_role = 'user'`);

    expect((await createInvite(cookie)).status).toBe(403);
  });
});
