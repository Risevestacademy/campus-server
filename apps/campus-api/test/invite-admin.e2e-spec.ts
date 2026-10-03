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
import {
  disabledEmailSender,
  EMAIL_SENDER,
} from './../src/infra/email/email-sender.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  CohortStatus,
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
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const MISSING = '99999999-9999-4999-8999-999999999999';
const db = drizzle(new PGlite(), { schema });

/**
 * The admin's view of the invites they have out: cancelling one, and listing
 * them. Admin-only throughout, like POST /v1/invites.
 */
describe('invite admin routes (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let memberCookie: string;
  let cohortId: string;
  let cohortTrackId: string;

  const as = (cookie: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .send(body),
  });

  const cookieFor = async (user: { id: string; email: string }) => {
    const { token } = await signSessionToken(
      { userId: user.id, email: user.email, scope: SessionScope.FullAccess },
      { secret: SECRET, ttlMinutes: 15 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue(disabledEmailSender)
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
      sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );
    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [member] = await db
      .insert(users)
      .values({ email: 'member@campus.local', systemRole: SystemRole.User })
      .returning();
    adminCookie = await cookieFor(admin);
    memberCookie = await cookieFor(member);

    // A cohort with a track, so a student invite has something to point at.
    const [track] = await db
      .insert(tracks)
      .values({ name: 'Software Engineering', code: 'SE' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1', status: CohortStatus.Active })
      .returning();
    const [link] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();
    cohortId = cohort.id;
    cohortTrackId = link.id;
  });

  const inviteBody = (email: string) => ({
    email,
    cohortId,
    cohortRole: CohortRole.Student,
    cohortTrackId,
  });

  const createInvite = (email: string) =>
    as(adminCookie).post('/v1/invites', inviteBody(email));

  describe('access', () => {
    it.each([
      ['get', '/v1/invites'],
      ['post', `/v1/invites/${MISSING}/revoke`],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    it('refuses the list to a non-admin', async () => {
      const res = await as(memberCookie).get('/v1/invites');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a revoke to a non-admin', async () => {
      const invite = await createInvite('someone@campus.local').expect(201);

      const res = await as(memberCookie).post(
        `/v1/invites/${invite.body.id}/revoke`,
        {},
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // Still pending: the refusal has to be the guard's, not a write that
      // happened to be rolled back.
      const listed = await as(adminCookie).get('/v1/invites');
      expect(listed.body.items[0].status).toBe('pending');
    });
  });

  describe('revoke', () => {
    it('revokes a pending invite and names the admin who did it', async () => {
      const invite = await createInvite('someone@campus.local').expect(201);

      const res = await as(adminCookie)
        .post(`/v1/invites/${invite.body.id}/revoke`, {})
        .expect(200);

      expect(res.body).toMatchObject({
        id: invite.body.id,
        status: 'revoked',
      });
      expect(res.body.revokedBy).toEqual(expect.any(String));
      expect(res.body.revokedAt).toEqual(expect.any(String));
    });

    it('answers a second revoke with INVITE_REVOKED', async () => {
      const invite = await createInvite('someone@campus.local').expect(201);
      await as(adminCookie).post(`/v1/invites/${invite.body.id}/revoke`, {});

      const res = await as(adminCookie).post(
        `/v1/invites/${invite.body.id}/revoke`,
        {},
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITE_REVOKED');
    });

    it('404s an invite that does not exist', async () => {
      const res = await as(adminCookie).post(
        `/v1/invites/${MISSING}/revoke`,
        {},
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects an id that is not a uuid', async () => {
      await as(adminCookie)
        .post('/v1/invites/not-a-uuid/revoke', {})
        .expect(400);
    });

    /**
     * The flow POST /v1/invites tells admins to take: the address is taken by
     * the pending invite, revoking frees the slot, and the re-invite succeeds.
     */
    it('frees the address so the same person can be invited again', async () => {
      const first = await createInvite('again@campus.local').expect(201);

      const blocked = await createInvite('again@campus.local');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toContain(
        'revoke it before re-inviting',
      );

      await as(adminCookie).post(`/v1/invites/${first.body.id}/revoke`, {});

      const second = await createInvite('again@campus.local').expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });

    /**
     * FORBIDDEN on this route already means "not an admin", so a lapsed invite
     * answers with its own code rather than one a client would read as that.
     */
    it('answers a lapsed invite with INVITE_EXPIRED', async () => {
      const invite = await createInvite('late@campus.local').expect(201);
      await db
        .update(schema.invites)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(sql`${schema.invites.id} = ${invite.body.id}`);

      const res = await as(adminCookie).post(
        `/v1/invites/${invite.body.id}/revoke`,
        {},
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVITE_EXPIRED');
    });
  });

  /**
   * Somebody signed in on an invite, part way through onboarding, when an
   * admin revokes it. Their session names the revoked invite and cannot be
   * re-issued from here, so the routes it calls have to tell them the truth:
   * closed if nothing replaced it, the new offer if something did.
   */
  describe('an invitee part way through onboarding', () => {
    const email = 'again@campus.local';
    let holder: string;
    let first: string;

    beforeEach(async () => {
      const [invitee] = await db
        .insert(users)
        .values({ email, systemRole: SystemRole.User })
        .returning();
      first = (await createInvite(email).expect(201)).body.id;
      const { token } = await signSessionToken(
        {
          userId: invitee.id,
          email,
          scope: SessionScope.Provisional,
          inviteId: first,
        },
        { secret: SECRET, ttlMinutes: 30 },
      );
      holder = `${SESSION_COOKIE}=${token}`;
      await as(adminCookie).post(`/v1/invites/${first}/revoke`, {}).expect(200);
    });

    const validate = () => as(holder).get('/v1/invites/validate-user-invite');
    const decide = (inviteId?: string) =>
      as(holder).post('/v1/invites/decision', { decision: 'accept', inviteId });

    it('is told the invite is closed when nothing replaced it', async () => {
      const read = await validate();
      expect(read.status).toBe(409);
      expect(read.body.error.code).toBe('INVITE_REVOKED');

      const answer = await decide();
      expect(answer.status).toBe(409);
      expect(answer.body.error.code).toBe('INVITE_REVOKED');
    });

    describe('once invited again', () => {
      let second: string;

      beforeEach(async () => {
        second = (await createInvite(email).expect(201)).body.id;
      });

      it('is shown the new invite', async () => {
        const read = await validate();
        expect(read.status).toBe(200);
        expect(read.body.id).toBe(second);

        const me = await as(holder).get('/v1/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.inviteId).toBe(second);
      });

      // Unnamed, a decision is about the invite the session was issued for:
      // the replacement is never accepted unseen.
      it('does not accept the new invite without naming it', async () => {
        const answer = await decide();
        expect(answer.status).toBe(409);
        expect(answer.body.error.code).toBe('INVITE_REVOKED');
      });

      it('accepts the new invite when it is named', async () => {
        const answer = await decide(second);
        expect(answer.status).toBe(200);
        expect(answer.body.inviteId).toBe(second);
      });

      it('refuses an invite that is not the replacement', async () => {
        const answer = await decide(MISSING);
        expect(answer.status).toBe(404);
      });
    });
  });

  describe('list', () => {
    it('returns the paginated envelope', async () => {
      await createInvite('a@campus.local').expect(201);

      const res = await as(adminCookie).get('/v1/invites').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.meta).toEqual({
        page: 1,
        perPage: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('honours page and perPage', async () => {
      await createInvite('a@campus.local').expect(201);
      await createInvite('b@campus.local').expect(201);
      await createInvite('c@campus.local').expect(201);

      const res = await as(adminCookie)
        .get('/v1/invites?page=1&perPage=2')
        .expect(200);

      expect(res.body.items).toHaveLength(2);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.meta.totalPages).toBe(2);
    });

    it('filters by status', async () => {
      const pending = await createInvite('open@campus.local').expect(201);
      const doomed = await createInvite('gone@campus.local').expect(201);
      await as(adminCookie).post(`/v1/invites/${doomed.body.id}/revoke`, {});

      const revoked = await as(adminCookie)
        .get('/v1/invites?status=revoked')
        .expect(200);
      expect(revoked.body.items.map((i: { id: string }) => i.id)).toEqual([
        doomed.body.id,
      ]);

      const open = await as(adminCookie)
        .get('/v1/invites?status=pending')
        .expect(200);
      expect(open.body.items.map((i: { id: string }) => i.id)).toEqual([
        pending.body.id,
      ]);
    });

    it('rejects a status that is not one of the five', async () => {
      await as(adminCookie).get('/v1/invites?status=nonsense').expect(400);
    });

    it('rejects perPage above the cap', async () => {
      await as(adminCookie).get('/v1/invites?perPage=500').expect(400);
    });

    /**
     * The reason this is not InviteResponseDto. That response carries the raw
     * token, correct only because it is returned once at creation; a list would
     * hand every unredeemed token in the system to any admin on page 1.
     */
    it('never carries a token or a shareable link', async () => {
      const invite = await createInvite('a@campus.local').expect(201);

      const res = await as(adminCookie).get('/v1/invites').expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain('token');
      expect(body).not.toContain(invite.body.token);
      expect(res.body.items[0]).not.toHaveProperty('token');
      expect(res.body.items[0]).not.toHaveProperty('inviteLink');
    });
  });

  describe('resend', () => {
    const createInvite = (email: string) =>
      as(adminCookie).post('/v1/invites', {
        email,
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
      });

    const resendInvite = (id: string) =>
      as(adminCookie).post(`/v1/invites/${id}/resend`, {});

    it('resends a pending invite with a new token and link', async () => {
      const invite = await createInvite('resend@campus.local').expect(201);
      const oldToken = invite.body.token;
      const oldLink = invite.body.inviteLink;

      const res = await resendInvite(invite.body.id).expect(200);

      expect(res.body.token).not.toBe(oldToken);
      expect(res.body.inviteLink).not.toBe(oldLink);
      expect(res.body.inviteLink).toContain(res.body.token);
      expect(res.body.emailStatus).toBe('disabled'); // email is disabled in test
      expect(res.body.id).toBe(invite.body.id); // same invite id
      expect(res.body.status).toBe('pending');
    });

    it('invalidates the old link (preview by old token fails)', async () => {
      const invite = await createInvite('oldlink@campus.local').expect(201);
      const oldToken = invite.body.token;

      const resend = await resendInvite(invite.body.id).expect(200);
      const newToken = resend.body.token;

      // Old token should no longer work
      const preview = await request(app.getHttpServer())
        .post('/v1/invites/preview')
        .send({ token: oldToken });
      expect(preview.status).toBe(404);
      expect(preview.body.error.code).toBe('NOT_FOUND');

      // New token should work
      const previewNew = await request(app.getHttpServer())
        .post('/v1/invites/preview')
        .send({ token: newToken });
      expect(previewNew.status).toBe(200);
    });

    it('returns 404 for unknown invite id', async () => {
      const res = await resendInvite(MISSING).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for non-uuid id', async () => {
      await resendInvite('not-a-uuid').expect(400);
    });

    it('returns 403 for non-admin', async () => {
      const invite = await createInvite('someone@campus.local').expect(201);

      const res = await as(memberCookie)
        .post(`/v1/invites/${invite.body.id}/resend`, {})
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('brings a lapsed invite back with a working link', async () => {
      const invite = await createInvite('lapsed@campus.local').expect(201);
      await db
        .update(schema.invites)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(sql`${schema.invites.id} = ${invite.body.id}`);

      const res = await resendInvite(invite.body.id).expect(200);

      expect(res.body.status).toBe('pending');
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      await request(app.getHttpServer())
        .post('/v1/invites/preview')
        .send({ token: res.body.token })
        .expect(200);
    });

    it('refuses a lapsed invite whose address has been invited again', async () => {
      const invite = await createInvite('lapsed@campus.local').expect(201);
      await db
        .update(schema.invites)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(sql`${schema.invites.id} = ${invite.body.id}`);
      await createInvite('lapsed@campus.local').expect(201);

      const res = await resendInvite(invite.body.id).expect(409);

      expect(res.body.error.code).toBe('CONFLICT');
    });

    it.each([
      ['accepted', 'INVITE_ALREADY_ACCEPTED'],
      ['declined', 'INVITE_ALREADY_DECLINED'],
      ['revoked', 'INVITE_REVOKED'],
    ])('returns %s for %s invite', async (status, expectedCode) => {
      const invite = await createInvite(`${status}@campus.local`).expect(201);
      await db
        .update(schema.invites)
        .set({ status })
        .where(sql`${schema.invites.id} = ${invite.body.id}`);

      const res = await resendInvite(invite.body.id).expect(409);
      expect(res.body.error.code).toBe(expectedCode);
    });
  });
});
