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
import { DRIZZLE } from './../src/infra/database/database.constants.js';
import { GoogleOAuthService } from './../src/modules/auth/google-oauth.service.js';
import { SessionIssuer } from './../src/modules/auth/session-issuer.js';
import { InviteStatus, invites } from './../src/modules/invites/schema.js';
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

const db = drizzle(new PGlite());

const IDENTITY = {
  subject: 'google-sub-e2e',
  email: 'ada@campus.local',
  emailVerified: true,
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
};

/** Stands in for Google, and for the token minting that has not landed yet. */
const google = {
  exchangeCode: vi.fn(),
  buildAuthorizationUrl: (state: string) =>
    `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`,
};

const sessions = {
  issueFullAccess: (user: { id: string }) => ({
    granted: 'full_access',
    userId: user.id,
  }),
  issueProvisional: (user: { id: string }, invite: { id: string }) => ({
    granted: 'provisional',
    userId: user.id,
    inviteId: invite.id,
  }),
};

describe('Google sign-in (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(GoogleOAuthService)
      .useValue(google)
      .overrideProvider(SessionIssuer)
      .useValue(sessions)
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
    await db.execute(sql`truncate users cascade`);
    google.exchangeCode.mockReset().mockResolvedValue(IDENTITY);
  });

  /** Walks the real first leg so the callback gets a state we actually issued. */
  async function beginSignIn(): Promise<{ state: string; cookie: string }> {
    const response = await request(app.getHttpServer())
      .get('/v1/auth/google')
      .expect(302);

    const state = new URL(response.headers.location).searchParams.get('state');
    const [cookie] = response.headers['set-cookie'];

    return { state: state as string, cookie };
  }

  const callback = async (state: string, cookie: string) =>
    request(app.getHttpServer())
      .get(`/v1/auth/google/callback?code=any-code&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookie);

  it('sends the browser to Google and leaves an httpOnly cookie behind', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/auth/google')
      .expect(302);

    expect(response.headers.location).toContain('accounts.google.com');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });

  it('turns an uninvited stranger away without creating an account', async () => {
    const { state, cookie } = await beginSignIn();

    const response = await callback(state, cookie);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: 'INVITE_REQUIRED',
        message: 'No invite found for this email',
      },
    });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('signs in an invited stranger provisionally and creates their account', async () => {
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning({ id: users.id });

    const [invite] = await db
      .insert(invites)
      .values({
        email: IDENTITY.email,
        tokenHash: 'hashed-token',
        status: InviteStatus.Pending,
        invitedBy: admin.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: invites.id });

    const { state, cookie } = await beginSignIn();
    const response = await callback(state, cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      granted: 'provisional',
      inviteId: invite.id,
    });
    expect(await db.select().from(users)).toHaveLength(2);
  });

  // The seeded admin has no Google subject until the moment they first sign
  // in, so this is the path that has to link one on.
  it('links the seeded admin to their Google identity and lets them in', async () => {
    await db
      .insert(users)
      .values({ email: IDENTITY.email, systemRole: SystemRole.Admin });

    const { state, cookie } = await beginSignIn();
    const response = await callback(state, cookie);

    expect(response.status).toBe(200);
    expect(response.body.granted).toBe('full_access');

    const [row] = await db.select().from(users);
    expect(row.providerId).toBe(IDENTITY.subject);
    expect(row.lastLoginAt).not.toBeNull();
  });

  it('rejects a callback whose cookie does not match its state', async () => {
    const { state } = await beginSignIn();
    const { cookie } = await beginSignIn();

    const response = await callback(state, cookie);

    expect(response.status).toBe(401);
    expect(response.body.error.details.reason).toBe('invalid_state');
  });

  it('rejects a callback carrying no state at all', async () => {
    const response = await request(app.getHttpServer()).get(
      '/v1/auth/google/callback?code=any-code',
    );

    expect(response.status).toBe(401);
    expect(google.exchangeCode).not.toHaveBeenCalled();
  });
});
