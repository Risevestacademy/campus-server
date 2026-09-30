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
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
import {
  REFRESH_COOKIE,
  SESSION_COOKIE,
} from './../src/modules/auth/session-cookie.js';
import { refreshTokens } from './../src/modules/auth/schema.js';
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
const ORIGIN = 'http://localhost:3000';

describe('refresh and logout sessions (e2e)', () => {
  let app: INestApplication<App>;
  let user: typeof users.$inferSelect;

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
    await db.execute(sql`truncate refresh_tokens, users cascade`);
    [user] = await db
      .insert(users)
      .values({
        email: 'refresh-e2e@campus.local',
        systemRole: SystemRole.Admin,
      })
      .returning();
  });

  async function issuedSession() {
    return app
      .get(SessionIssuer)
      .issueFullAccess(user, { endsAt: null }, new Date());
  }

  it('rotates the refresh cookie and scopes it to the auth path', async () => {
    const issued = await issuedSession();

    const response = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', ORIGIN)
      .expect(200);

    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=.*Path=/;`)),
        expect.stringMatching(
          new RegExp(`^${REFRESH_COOKIE}=.*Path=/v1/auth;`),
        ),
      ]),
    );

    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows[0].usedAt).not.toBeNull();
  });

  // The web app schedules its next refresh from this, rather than guessing
  // at a lifetime a guest's visit may have cut short.
  it('says in the body when the new tokens lapse, and nothing more', async () => {
    const issued = await issuedSession();
    const before = Date.now();

    const response = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', ORIGIN)
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      'expiresAt',
      'refreshExpiresAt',
    ]);
    const expiresAt = new Date(response.body.expiresAt).getTime();
    const refreshExpiresAt = new Date(response.body.refreshExpiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before);
    expect(refreshExpiresAt).toBeGreaterThan(expiresAt);

    const session = (response.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(new Date(/Expires=([^;]+)/.exec(session!)![1]).getTime()).toBe(
      expiresAt,
    );
  });

  it('rejects a cookie request from an untrusted origin', async () => {
    const issued = await issuedSession();

    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', 'https://attacker.example')
      .expect(401);
  });

  it('rejects a logout from an untrusted origin without revoking', async () => {
    const issued = await issuedSession();

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', 'https://attacker.example')
      .expect(401);

    const [row] = await db.select().from(refreshTokens);
    expect(row.revokedAt).toBeNull();
  });

  it('logs out, clears both cookies, and revokes the family', async () => {
    const issued = await issuedSession();

    const response = await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', ORIGIN)
      .expect(204);

    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=;.*Path=/;`)),
        expect.stringMatching(
          new RegExp(`^${REFRESH_COOKIE}=;.*Path=/v1/auth;`),
        ),
      ]),
    );

    const [row] = await db.select().from(refreshTokens);
    expect(row.revokedAt).not.toBeNull();

    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', ORIGIN)
      .expect(401);
  });

  it('rejects suspended users and revokes their refresh family', async () => {
    const issued = await issuedSession();
    await db
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, user.id));

    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${issued.refreshToken}`)
      .set('Origin', ORIGIN)
      .expect(401);

    const [row] = await db.select().from(refreshTokens);
    expect(row.revokedAt).not.toBeNull();
  });
});
