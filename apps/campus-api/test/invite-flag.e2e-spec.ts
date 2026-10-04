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
  EMAIL_SENDER,
  type OutgoingEmail,
} from './../src/infra/email/email-sender.js';
import { SESSION_COOKIE } from './../src/modules/auth/session-cookie.js';
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { InviteStatus, invites } from './../src/modules/invites/schema.js';
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
const MESSAGE = 'I applied for Product Design, not Software Engineering.';
const db = drizzle(new PGlite(), { schema });

/**
 * The invitee telling the admin the offer is wrong. What matters end to end
 * is that it reaches the admin — by email and in their list — and that it
 * gets in the way of nothing: the invite is still there to accept.
 */
describe('POST /v1/invites/flag (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let cohortTrackId: string;
  let inviterId: string;
  let inviteeId: string;
  let adminCookie: string;
  const inviteeEmail = 'invitee@campus.local';
  const sent: OutgoingEmail[] = [];
  let emailOk = true;

  const cookieFor = async (
    userId: string,
    email: string,
    scope: SessionScope,
    inviteId?: string,
  ) => {
    const { token } = await signSessionToken(
      { userId, email, scope, inviteId },
      { secret: SECRET, ttlMinutes: 30 },
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  const provisional = (inviteId: string) =>
    cookieFor(inviteeId, inviteeEmail, SessionScope.Provisional, inviteId);

  const post = async (
    path: string,
    cookie: string | Promise<string> | undefined,
    body: object,
  ) => {
    const req = request(app.getHttpServer())
      .post(path)
      .set('Origin', 'http://localhost:3000');
    if (cookie) req.set('Cookie', await cookie);
    return req.send(body);
  };

  const flag = (cookie: string | Promise<string> | undefined, body: object) =>
    post('/v1/invites/flag', cookie, body);

  const makeInvite = async (
    overrides: Partial<typeof invites.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(invites)
      .values({
        email: inviteeEmail,
        invitedBy: inviterId,
        tokenHash: 'hash-' + Math.random().toString(36).slice(2),
        expiresAt: new Date(Date.now() + 86_400_000),
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
        ...overrides,
      })
      .returning();
    return row;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        enabled: true,
        send: (email: OutgoingEmail) => {
          sent.push(email);
          return Promise.resolve(
            emailOk
              ? { ok: true, id: 'em_1' }
              : { ok: false, reason: 'refused' },
          );
        },
      })
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
    // Listening once, rather than app.init(): supertest otherwise opens and
    // closes a server on a new port for every request, and with the files
    // running in parallel those ports get handed between workers mid-request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate audit_log, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );
    sent.length = 0;
    emailOk = true;

    const [admin] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const [invitee] = await db
      .insert(users)
      .values({ email: inviteeEmail })
      .returning();
    const [track] = await db
      .insert(tracks)
      .values({ name: 'Software Engineering', code: 'SE' })
      .returning();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning();
    const [link] = await db
      .insert(cohortTracks)
      .values({ cohortId: cohort.id, trackId: track.id })
      .returning();

    inviterId = admin.id;
    inviteeId = invitee.id;
    cohortId = cohort.id;
    cohortTrackId = link.id;
    adminCookie = await cookieFor(
      admin.id,
      admin.email,
      SessionScope.FullAccess,
    );
  });

  it('refuses without a session', async () => {
    const res = await flag(undefined, { message: MESSAGE });

    expect(res.status).toBe(401);
  });

  it('records the flag and emails the admin who sent the invite', async () => {
    const invite = await makeInvite();

    const res = await flag(provisional(invite.id), { message: MESSAGE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      inviteId: invite.id,
      flaggedAt: expect.any(String),
    });
    // A flag is not an answer, so the session is left exactly as it was.
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('admin@campus.local');
    expect(sent[0].subject).toContain(inviteeEmail);
    expect(sent[0].text).toContain(MESSAGE);
  });

  it('shows the flag to an admin in the invite list', async () => {
    const invite = await makeInvite();
    await makeInvite({ email: 'other@campus.local' });
    await flag(provisional(invite.id), { message: MESSAGE });

    const res = await request(app.getHttpServer())
      .get('/v1/invites?flagged=true')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(res.body.meta.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: invite.id,
      status: 'pending',
      flagMessage: MESSAGE,
      flaggedAt: expect.any(String),
    });
  });

  it('rejects a flagged filter that is not a boolean', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/invites?flagged=yes')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.flagged).toEqual(expect.any(String));
  });

  it('tells the invitation screen the invite has been flagged', async () => {
    const invite = await makeInvite();
    const cookie = await provisional(invite.id);
    const read = () =>
      request(app.getHttpServer())
        .get('/v1/invites/validate-user-invite')
        .set('Cookie', cookie);

    expect((await read()).body.flaggedAt).toBeNull();
    await flag(cookie, { message: MESSAGE });
    expect((await read()).body.flaggedAt).toEqual(expect.any(String));
  });

  it('still accepts a flagged invite', async () => {
    const invite = await makeInvite();
    const cookie = await provisional(invite.id);
    await flag(cookie, { message: MESSAGE });

    const res = await post('/v1/invites/decision', cookie, {
      decision: 'accept',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(InviteStatus.Accepted);
    const members = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, inviteeId));
    expect(members).toHaveLength(1);
  });

  it('keeps the flag when the email cannot be sent', async () => {
    emailOk = false;
    const invite = await makeInvite();

    const res = await flag(provisional(invite.id), { message: MESSAGE });

    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, invite.id));
    expect(row.flagMessage).toBe(MESSAGE);
  });

  it('refuses a second flag without a second email', async () => {
    const invite = await makeInvite();
    const cookie = await provisional(invite.id);
    await flag(cookie, { message: MESSAGE });

    const res = await flag(cookie, { message: 'and another thing' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['missing', {}],
    ['blank', { message: '   ' }],
    ['too long', { message: 'x'.repeat(1001) }],
  ])('rejects a %s message', async (_label, body) => {
    const invite = await makeInvite();

    const res = await flag(provisional(invite.id), body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.message).toEqual(expect.any(String));
    expect(sent).toHaveLength(0);
  });

  // Postgres refuses NUL in text, so one that got through would be a 500.
  it('drops a NUL character from the message', async () => {
    const invite = await makeInvite();

    const res = await flag(provisional(invite.id), {
      message: 'wrong\u0000 track',
    });

    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, invite.id));
    expect(row.flagMessage).toBe('wrong track');
  });

  it('answers a revoked invite with INVITE_REVOKED', async () => {
    const invite = await makeInvite({ status: InviteStatus.Revoked });

    const res = await flag(provisional(invite.id), { message: MESSAGE });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_REVOKED');
    expect(sent).toHaveLength(0);
  });

  describe('a member invited to another cohort', () => {
    const member = () =>
      cookieFor(inviteeId, inviteeEmail, SessionScope.FullAccess);

    it('must name the invite', async () => {
      await makeInvite();

      const res = await flag(member(), { message: MESSAGE });

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields.inviteId).toEqual(
        expect.any(String),
      );
    });

    it('flags the invite it names', async () => {
      const invite = await makeInvite();

      const res = await flag(member(), {
        message: MESSAGE,
        inviteId: invite.id,
      });

      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it('cannot flag an invite addressed to somebody else', async () => {
      const theirs = await makeInvite({ email: 'other@campus.local' });

      const res = await flag(member(), {
        message: MESSAGE,
        inviteId: theirs.id,
      });

      expect(res.status).toBe(404);
      expect(sent).toHaveLength(0);
    });
  });
});
