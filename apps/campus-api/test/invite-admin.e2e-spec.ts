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
    await app.init();
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
});
