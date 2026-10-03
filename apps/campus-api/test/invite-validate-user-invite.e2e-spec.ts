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
import { SessionScope, signSessionToken } from '@campus/session';
import {
  CohortRole,
  cohortTracks,
  cohorts,
} from './../src/modules/cohorts/schema.js';
import { tracks } from './../src/modules/tracks/schema.js';
import { SystemRole, users } from './../src/modules/users/schema.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';
import { ValidationException } from './../src/shared/exceptions/index.js';

const MIGRATIONS = fileURLToPath(
  new URL('../src/infra/database/migrations', import.meta.url),
);
const SECRET = 'an-e2e-session-secret-of-at-least-32-chars';
const URL_UNDER_TEST = '/v1/invites/validate-user-invite';

const db = drizzle(new PGlite(), { schema });

/**
 * The route is the invitee's first authenticated read, and everything that
 * makes it safe lives in wiring the service spec cannot see: the scope check,
 * the absence of a request body, and what the 200 body does not carry.
 */
describe('GET /v1/invites/validate-user-invite (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let cohortTrackId: string;
  let inviterId: string;

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

  const provisional = (userId: string, email: string, inviteId: string) =>
    cookieFor(userId, email, SessionScope.Provisional, inviteId);

  const call = (cookie?: string) => {
    const req = request(app.getHttpServer()).get(URL_UNDER_TEST);
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
    await db.execute(
      sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

    const [admin] = await db
      .insert(users)
      .values({
        email: 'admin@campus.local',
        systemRole: SystemRole.Admin,
        firstName: 'Ada',
        lastName: 'Lovelace',
      })
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
    cohortId = cohort.id;
    cohortTrackId = link.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const seedInvite = async (email: string) => {
    const [invite] = await db
      .insert(schema.invites)
      .values({
        email,
        cohortId,
        cohortTrackId,
        cohortRole: CohortRole.Student,
        invitedBy: inviterId,
        tokenHash: `hash-${email}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    return invite;
  };

  const seedInvitee = async (email: string) => {
    const [user] = await db
      .insert(users)
      .values({ email, firstName: 'New', lastName: 'Student' })
      .returning();
    return user;
  };

  it('returns the live invite a provisional session was issued for', async () => {
    const invitee = await seedInvitee('invitee@campus.local');
    const invite = await seedInvite(invitee.email);

    const response = await call(
      await provisional(invitee.id, invitee.email, invite.id),
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(invite.id);
    expect(response.body.cohort.id).toBe(cohortId);
    expect(response.body.cohortTrack.id).toBe(cohortTrackId);
    expect(response.body.track.name).toBe('Software Engineering');
    expect(response.body.cohortRole).toBe(CohortRole.Student);
    expect(response.body.systemRole).toBe(SystemRole.User);
    expect(response.body.status).toBe('pending');
    expect(response.body.invitedBy).toEqual({
      id: inviterId,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(response.body.user.email).toBe(invitee.email);
  });

  /**
   * The DTO types these as Date; over HTTP they are ISO text. Pinning it here
   * is what stops the contract depending on an accident of JSON.stringify —
   * a Date-shaped value whose toJSON fails would arrive null and nothing in
   * the type system would notice.
   */
  it('sends timestamps as ISO 8601 text', async () => {
    const invitee = await seedInvitee('invitee@campus.local');
    const invite = await seedInvite(invitee.email);

    const response = await call(
      await provisional(invitee.id, invitee.email, invite.id),
    );

    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(response.body.expiresAt).toMatch(iso);
    expect(response.body.createdAt).toMatch(iso);
    expect(response.body.cohort.createdAt).toMatch(iso);
    expect(response.body.cohort.updatedAt).toMatch(iso);
    expect(response.body.cohortTrack.createdAt).toMatch(iso);
    expect(response.body.track.createdAt).toMatch(iso);
    expect(response.body.user.createdAt).toMatch(iso);
  });

  it('omits the token, the link, the invited address and the mentorship group', async () => {
    const invitee = await seedInvitee('invitee@campus.local');
    const invite = await seedInvite(invitee.email);

    const response = await call(
      await provisional(invitee.id, invitee.email, invite.id),
    );

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('token');
    expect(response.body).not.toHaveProperty('tokenHash');
    expect(response.body).not.toHaveProperty('inviteLink');
    expect(response.body).not.toHaveProperty('mentorshipGroupId');
    expect(response.body).not.toHaveProperty('email');
    expect(JSON.stringify(response.body)).not.toContain('hash-invitee@');
  });

  /** The 200 is a promise the endpoint can only keep while the offer is live. */
  it('403s a lapsed invite', async () => {
    const invitee = await seedInvitee('invitee@campus.local');
    const invite = await seedInvite(invitee.email);
    await db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(sql`${schema.invites.id} = ${invite.id}`);

    const response = await call(
      await provisional(invitee.id, invitee.email, invite.id),
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INVITE_EXPIRED');
  });

  it('409s an invite that was already resolved', async () => {
    const invitee = await seedInvitee('invitee@campus.local');
    const invite = await seedInvite(invitee.email);
    await db
      .update(schema.invites)
      .set({ status: schema.InviteStatus.Declined })
      .where(sql`${schema.invites.id} = ${invite.id}`);

    const response = await call(
      await provisional(invitee.id, invitee.email, invite.id),
    );

    expect(response.status).toBe(409);
    // Same code the decision route reports for the same state, so a caller
    // that validates before deciding only has to learn one vocabulary.
    expect(response.body.error.code).toBe('INVITE_ALREADY_DECLINED');
  });

  it('404s a session whose invite does not exist', async () => {
    const invitee = await seedInvitee('invitee@campus.local');

    const response = await call(
      await provisional(
        invitee.id,
        invitee.email,
        '00000000-0000-4000-8000-000000000000',
      ),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  /**
   * The session names the invite; the USERS row names the account. Only
   * together do they mean anything, so a session pointed at someone else's
   * offer must not read it. Answered 500 because no caller can reach that
   * state — the pair is entirely server-derived.
   */
  it('does not surface an invite addressed to a different account', async () => {
    const owner = await seedInvitee('owner@campus.local');
    const impostor = await seedInvitee('impostor@campus.local');
    const invite = await seedInvite(owner.email);

    const response = await call(
      await provisional(impostor.id, impostor.email, invite.id),
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    // Neither address may reach the client, in the message OR the details —
    // DomainExceptionFilter catches this before GlobalExceptionFilter can, so
    // the details used to come straight through.
    const wire = JSON.stringify(response.body);
    expect(wire).not.toContain('owner@campus.local');
    expect(wire).not.toContain('impostor@campus.local');
    expect(response.body.error.details).toBeUndefined();
    expect(response.body.error.message).toBe('An unexpected error occurred');
  });

  it('refuses a caller with no session', async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  /**
   * The route exists to finish onboarding, so a full-access session is the
   * wrong caller entirely — and it is the one that could reach a route this
   * way by accident, which is why the scope is a separate guard.
   */
  /**
   * A member can belong to several cohorts, so a full-access session can hold
   * an invite too: the pending one addressed to its account.
   */
  it('shows a member the invite addressed to them', async () => {
    const member = await seedInvitee('member@campus.local');
    const invite = await seedInvite(member.email);

    const response = await call(
      await cookieFor(member.id, member.email, SessionScope.FullAccess),
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(invite.id);
    expect(response.body.cohort.id).toBe(cohortId);
  });

  it('answers 404 to a member with no pending invite', async () => {
    const member = await seedInvitee('member@campus.local');

    const response = await call(
      await cookieFor(member.id, member.email, SessionScope.FullAccess),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
