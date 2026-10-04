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
import { GoogleSignInFailedError } from './../src/modules/auth/auth.exceptions.js';
import { GoogleOAuthService } from './../src/modules/auth/google-oauth.service.js';
import { refreshTokens } from './../src/modules/auth/schema.js';
import { REFRESH_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, verifySessionToken } from '@campus/session';
import {
  CohortRole,
  cohortMembers,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { InviteDecision } from './../src/modules/invites/dto/invite-decision.dto.js';
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
const SESSION_SECRET = 'an-e2e-session-secret-of-at-least-32-chars';

const db = drizzle(new PGlite(), { schema });

const IDENTITY = {
  subject: 'google-sub-mobile',
  email: 'ada@campus.local',
  emailVerified: true,
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
};

/** Stands in for Google: the app's id_token is taken as already checked. */
const google = { verifyIdToken: vi.fn() };

/**
 * A native app has no cookie jar, so every route that hands a browser its
 * session in Set-Cookie has to hand a native app the same session in the
 * body, and take it back the same way. What is checked here is the whole
 * life of one: sign in, call the API, refresh, answer an invite, sign out —
 * without a cookie anywhere.
 */
describe('sessions for a client without cookies (e2e)', () => {
  let app: INestApplication<App>;
  let adminId: string;
  let cohortId: string;

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
      sql`truncate refresh_tokens, invites, cohort_members, cohorts, users cascade`,
    );
    google.verifyIdToken.mockReset().mockResolvedValue(IDENTITY);

    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning({ id: users.id });
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning({ id: cohorts.id });
    adminId = admin.id;
    cohortId = cohort.id;
  });

  const signIn = () =>
    request(app.getHttpServer())
      .post('/v1/auth/google/token')
      .send({ idToken: 'an-id-token-from-the-sdk' });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Ada, already on the roster. */
  async function seedMember(): Promise<string> {
    const [member] = await db
      .insert(users)
      .values({ email: IDENTITY.email })
      .returning({ id: users.id });
    await db.insert(cohortMembers).values({
      cohortId,
      userId: member.id,
      role: CohortRole.Mentor,
    });
    return member.id;
  }

  /** An invite addressed to Ada, who is not a member of anything yet. */
  async function seedInvite(): Promise<string> {
    const [invite] = await db
      .insert(invites)
      .values({
        email: IDENTITY.email,
        tokenHash: 'hashed-token',
        status: InviteStatus.Pending,
        invitedBy: adminId,
        cohortId,
        cohortRole: CohortRole.Mentor,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: invites.id });
    return invite.id;
  }

  describe('POST /v1/auth/google/token', () => {
    it('hands a member a full-access session in the body, and no cookie', async () => {
      const memberId = await seedMember();

      const response = await signIn().expect(200);

      expect(google.verifyIdToken).toHaveBeenCalledWith(
        'an-id-token-from-the-sdk',
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).toMatchObject({
        scope: SessionScope.FullAccess,
        inviteId: null,
      });
      expect(response.body.refreshToken).toEqual(expect.any(String));
      expect(
        new Date(response.body.refreshExpiresAt).getTime(),
      ).toBeGreaterThan(new Date(response.body.expiresAt).getTime());

      const claims = await verifySessionToken(
        response.body.accessToken,
        SESSION_SECRET,
      );
      expect(claims).toMatchObject({
        scope: SessionScope.FullAccess,
        userId: memberId,
      });
    });

    it('issues a token the ordinary routes take as a bearer token', async () => {
      await seedMember();
      const { body } = await signIn().expect(200);

      const me = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set(bearer(body.accessToken))
        .expect(200);

      expect(me.body.scope).toBe(SessionScope.FullAccess);
      expect(me.body.user.email).toBe(IDENTITY.email);
      expect(me.body.memberships).toHaveLength(1);
    });

    it('hands an invited stranger a provisional session naming the invite', async () => {
      const inviteId = await seedInvite();

      const response = await signIn().expect(200);

      expect(response.body).toMatchObject({
        scope: SessionScope.Provisional,
        inviteId,
        refreshToken: null,
        refreshExpiresAt: null,
      });
      const claims = await verifySessionToken(
        response.body.accessToken,
        SESSION_SECRET,
      );
      expect(claims.inviteId).toBe(inviteId);
      expect(await db.select().from(refreshTokens)).toHaveLength(0);
    });

    it('tells a member about an invite to another cohort without costing them access', async () => {
      await seedMember();
      const [next] = await db
        .insert(cohorts)
        .values({ name: 'Cohort 2', code: 'C2' })
        .returning({ id: cohorts.id });
      const [invite] = await db
        .insert(invites)
        .values({
          email: IDENTITY.email,
          tokenHash: 'another-hashed-token',
          invitedBy: adminId,
          cohortId: next.id,
          cohortRole: CohortRole.Mentor,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: invites.id });

      const response = await signIn().expect(200);

      expect(response.body).toMatchObject({
        scope: SessionScope.FullAccess,
        inviteId: invite.id,
      });
    });

    // JSON, not the redirect the browser callback answers with: there is no
    // page to send a native app back to.
    it('turns an uninvited stranger away in the error contract, leaving no account', async () => {
      const response = await signIn().expect(403);

      expect(response.body.error.code).toBe('INVITE_REQUIRED');
      expect(await db.select().from(users)).toHaveLength(1);
    });

    it('refuses an id_token Google will not vouch for', async () => {
      google.verifyIdToken.mockRejectedValue(
        new GoogleSignInFailedError('exchange_failed'),
      );

      const response = await signIn().expect(401);

      expect(response.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        details: { reason: 'exchange_failed' },
      });
    });

    it('asks for the id_token when the body has none', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/google/token')
        .send({})
        .expect(400);

      expect(response.body.error.details.fields.idToken).toBeDefined();
      expect(google.verifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/auth/refresh with the token in the body', () => {
    it('answers with the new pair in the body, and no cookie', async () => {
      await seedMember();
      const { body: first } = await signIn().expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);

      expect(response.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(response.body).sort()).toEqual([
        'accessToken',
        'expiresAt',
        'refreshExpiresAt',
        'refreshToken',
      ]);
      expect(response.body.refreshToken).not.toBe(first.refreshToken);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set(bearer(response.body.accessToken))
        .expect(200);
    });

    it('rotates within the family the sign-in started', async () => {
      await seedMember();
      const { body: first } = await signIn().expect(200);

      const { body: second } = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(200);

      const rows = await db.select().from(refreshTokens);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
      expect(rows.filter((row) => row.usedAt !== null)).toHaveLength(2);
    });

    it('refuses a refresh token it never issued', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'not-a-token-we-issued' })
        .expect(401);
    });

    it('still asks for a token when there is neither cookie nor body', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .expect(401);

      expect(response.body.error.message).toBe('Refresh token required');
    });

    // A page that could choose the body would be handed tokens its script
    // can read, which is what the httpOnly cookie exists to prevent.
    it('answers a browser in cookies even when it sends a body too', async () => {
      await seedMember();
      const { body: first } = await signIn().expect(200);
      const { body: other } = await signIn().expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${first.refreshToken}`)
        .set('Origin', 'http://localhost:3000')
        .send({ refreshToken: other.refreshToken })
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'expiresAt',
        'refreshExpiresAt',
      ]);
      expect(response.headers['set-cookie']).toBeDefined();
    });
  });

  describe('POST /v1/auth/logout with the token in the body', () => {
    it('revokes the family, so the refresh token is dead afterwards', async () => {
      await seedMember();
      const { body } = await signIn().expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({ refreshToken: body.refreshToken })
        .expect(204);

      const [row] = await db.select().from(refreshTokens);
      expect(row.revokedAt).not.toBeNull();
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: body.refreshToken })
        .expect(401);
    });

    it('answers 204 with no body at all, as it does for a browser', async () => {
      await request(app.getHttpServer()).post('/v1/auth/logout').expect(204);
    });
  });

  describe('POST /v1/invites/decision with a bearer token', () => {
    it('hands back the full-access session an accept upgraded to', async () => {
      const inviteId = await seedInvite();
      const { body: provisional } = await signIn().expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(bearer(provisional.accessToken))
        .send({ decision: InviteDecision.Accept })
        .expect(200);

      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).toMatchObject({
        inviteId,
        status: InviteStatus.Accepted,
        session: { scope: SessionScope.FullAccess },
      });
      expect(response.body.session.refreshToken).toEqual(expect.any(String));

      const me = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set(bearer(response.body.session.accessToken))
        .expect(200);
      expect(me.body.scope).toBe(SessionScope.FullAccess);
      expect(me.body.inviteId).toBeNull();

      // And it can be kept alive the same way as a session from sign-in.
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken: response.body.session.refreshToken })
        .expect(200);
    });

    it('hands back no session on a decline, and touches no cookie', async () => {
      await seedInvite();
      const { body: provisional } = await signIn().expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(bearer(provisional.accessToken))
        .send({ decision: InviteDecision.Decline })
        .expect(200);

      expect(response.body.status).toBe(InviteStatus.Declined);
      expect(response.body.session).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('leaves a member answering another invite on the session they hold', async () => {
      await seedMember();
      const [next] = await db
        .insert(cohorts)
        .values({ name: 'Cohort 2', code: 'C2' })
        .returning({ id: cohorts.id });
      const [invite] = await db
        .insert(invites)
        .values({
          email: IDENTITY.email,
          tokenHash: 'another-hashed-token',
          invitedBy: adminId,
          cohortId: next.id,
          cohortRole: CohortRole.Mentor,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: invites.id });
      const { body: member } = await signIn().expect(200);

      const response = await request(app.getHttpServer())
        .post('/v1/invites/decision')
        .set(bearer(member.accessToken))
        .send({ decision: InviteDecision.Accept, inviteId: invite.id })
        .expect(200);

      expect(response.body.status).toBe(InviteStatus.Accepted);
      expect(response.body.session).toBeUndefined();
    });
  });
});
