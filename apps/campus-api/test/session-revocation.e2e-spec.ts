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
import {
  SessionIssuer,
  type FullAccessSession,
} from './../src/modules/auth/session-issuer.js';
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

/**
 * Ending an account's sessions on purpose, from the outside: what somebody
 * holding a perfectly good token sees the moment after. The unit specs prove
 * the two halves — the guard's comparison and the helper's writes — and this
 * proves they meet: real tokens from the real issuer, through the real
 * guard.
 */
describe('session revocation (e2e)', () => {
  let app: INestApplication<App>;
  let issuer: SessionIssuer;
  let account: typeof users.$inferSelect;
  let session: FullAccessSession;

  const me = (token: string) =>
    request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken });

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
    // Listening once, rather than app.init(): supertest otherwise opens a
    // server on a new port for every request, and files running in parallel
    // collide on them.
    await app.listen(0);
    issuer = app.get(SessionIssuer);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate refresh_tokens, users cascade`);
    [account] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    session = await issuer.issueFullAccess(account, { endsAt: null });
  });

  it('lets a session through until it is revoked', async () => {
    await me(session.token).expect(200);
  });

  it('refuses the access token on the very next request', async () => {
    await issuer.revokeAllSessions(account.id);

    const res = await me(session.token);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Session has been revoked',
    });
  });

  // Without this half the access token would be dead and the session would
  // not be: one refresh, and a new token on the new epoch walks back in.
  it('refuses the refresh token too', async () => {
    await issuer.revokeAllSessions(account.id);

    const res = await refresh(session.refreshToken);

    expect(res.status).toBe(401);
  });

  it('ends every device the account is signed in on', async () => {
    const phone = await issuer.issueFullAccess(account, { endsAt: null });

    await issuer.revokeAllSessions(account.id);

    await me(session.token).expect(401);
    await me(phone.token).expect(401);
    await refresh(phone.refreshToken).expect(401);
  });

  it('leaves everybody else signed in', async () => {
    const [other] = await db
      .insert(users)
      .values({ email: 'other@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const theirs = await issuer.issueFullAccess(other, { endsAt: null });

    await issuer.revokeAllSessions(account.id);

    await me(theirs.token).expect(200);
    await refresh(theirs.refreshToken).expect(200);
  });

  // Revoking ends sessions; it does not close the account. Whatever took the
  // access away decides whether they may come back.
  // A sign-in decided before the revoke, and only minted after it, is held
  // to the account as it was when it was decided.
  it('refuses to issue a session decided on before the revoke', async () => {
    await issuer.revokeAllSessions(account.id);

    await expect(
      issuer.issueFullAccess(account, { endsAt: null }),
    ).rejects.toThrow('Session has been revoked');
  });

  it('accepts a session issued after the revoke', async () => {
    await issuer.revokeAllSessions(account.id);

    // A new sign-in starts from the account as it is now.
    const [current] = await db
      .select()
      .from(users)
      .where(eq(users.id, account.id));
    const fresh = await issuer.issueFullAccess(current, { endsAt: null });

    await me(fresh.token).expect(200);
    await me(session.token).expect(401);
  });

  // A refresh a moment before the revoke hands out a new pair on the old
  // epoch. Both halves of it are dead as soon as the revoke lands.
  it('refuses a pair minted by a refresh just before the revoke', async () => {
    const rotated = await refresh(session.refreshToken).expect(200);
    await issuer.revokeAllSessions(account.id);

    await me(rotated.body.accessToken).expect(401);
    await refresh(rotated.body.refreshToken).expect(401);
  });
});
