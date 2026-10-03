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
import {
  SESSION_COOKIE,
  readSessionCookie,
} from './../src/modules/auth/session-cookie.js';
import {
  SessionScope,
  signSessionToken,
  verifySessionToken,
} from '@campus/session';
import {
  CohortRole,
  cohortMembers,
  cohortTracks,
  cohorts,
  StudentStatus,
} from './../src/modules/cohorts/schema.js';
import { AuditAction, auditLog } from './../src/modules/audit/schema.js';
import { InviteDecision } from './../src/modules/invites/dto/invite-decision.dto.js';
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
const URL_UNDER_TEST = '/v1/invites/decision';

const db = drizzle(new PGlite(), { schema });

/**
 * The route the whole onboarding flow turns on, and the only place a
 * provisional session becomes a full-access one. What the service spec cannot
 * see is the half that matters most here: the Set-Cookie that carries the
 * upgrade, and the clearing of it on a decline. A service test that passes
 * while the cookie is never written would leave every invitee stranded.
 */
describe('POST /v1/invites/decision (e2e)', () => {
  let app: INestApplication<App>;
  let cohortId: string;
  let cohortTrackId: string;
  let inviterId: string;
  let inviteeId: string;
  const inviteeEmail = 'invitee@campus.local';

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

  const decide = async (
    cookie: string | Promise<string> | undefined,
    decision: string,
    inviteId?: string,
  ) => {
    const req = request(app.getHttpServer()).post(URL_UNDER_TEST);
    if (cookie) req.set('Cookie', await cookie);
    return req.send({ decision, inviteId });
  };

  /** Reads the session cookie out of a Set-Cookie header list, if present. */
  const sessionCookieOf = (res: request.Response): string | undefined => {
    const raw = res.headers['set-cookie'];
    if (!raw) return undefined;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) {
      if (entry.startsWith(`${SESSION_COOKIE}=`)) return entry;
    }
    return undefined;
  };

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
        // An invite naming no cohort can only be an admin one.
        systemRole:
          overrides.cohortId == null ? SystemRole.Admin : SystemRole.User,
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
      sql`truncate audit_log, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

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
  });

  it('accepts and replaces the provisional cookie with a full-access one', async () => {
    const invite = await makeInvite({
      cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId,
    });

    const res = await decide(provisional(invite.id), InviteDecision.Accept);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(InviteStatus.Accepted);
    expect(res.body.membership.role).toBe(CohortRole.Student);
    expect(res.body.membership.status).toBe(StudentStatus.Active);

    // The upgrade is the whole point: the new cookie must verify as
    // full_access, and must no longer name the invite.
    const setCookie = sessionCookieOf(res);
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');

    const token = readSessionCookie(setCookie)!;
    const claims = await verifySessionToken(token, SECRET);
    expect(claims.scope).toBe(SessionScope.FullAccess);
    expect(claims.inviteId).toBeUndefined();
    expect(claims.userId).toBe(inviteeId);
  });

  it('lets the upgraded cookie reach a full-access route', async () => {
    const invite = await makeInvite({
      cohortId,
      cohortRole: CohortRole.Professor,
    });

    const res = await decide(provisional(invite.id), InviteDecision.Accept);
    const upgraded = sessionCookieOf(res)!;

    // /auth/me reads the scope from the cookie itself — proof the scope
    // really changed rather than the claim merely being relabelled.
    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', upgraded);
    expect(me.status).toBe(200);
    expect(me.body.scope).toBe(SessionScope.FullAccess);
  });

  it('refuses a provisional decision naming a different invite', async () => {
    const invite = await makeInvite({
      cohortId,
      cohortRole: CohortRole.Mentor,
    });

    const res = await decide(
      provisional(invite.id),
      InviteDecision.Accept,
      '99999999-9999-4999-8999-999999999999',
    );

    expect(res.status).toBe(404);
  });

  /**
   * A person can belong to several cohorts, in any mix of roles. A member of
   * one, invited to another, answers from the session they already hold.
   */
  describe('a member invited to another cohort', () => {
    let otherCohortId: string;
    let member: string;

    beforeEach(async () => {
      const [other] = await db
        .insert(cohorts)
        .values({ name: 'Cohort 2', code: 'C2' })
        .returning();
      otherCohortId = other.id;
      await db.insert(cohortMembers).values({
        cohortId: otherCohortId,
        userId: inviteeId,
        role: CohortRole.Professor,
      });
      member = await cookieFor(
        inviteeId,
        inviteeEmail,
        SessionScope.FullAccess,
      );
    });

    it('joins the new cohort and keeps the one they had', async () => {
      const invite = await makeInvite({
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
      });

      const res = await decide(member, InviteDecision.Accept, invite.id);

      expect(res.status).toBe(200);
      expect(res.body.membership).toMatchObject({
        cohortId,
        role: CohortRole.Student,
      });
      const rows = await db
        .select()
        .from(cohortMembers)
        .where(eq(cohortMembers.userId, inviteeId));
      expect(rows.map((r) => [r.cohortId, r.role]).sort()).toEqual(
        [
          [otherCohortId, CohortRole.Professor],
          [cohortId, CohortRole.Student],
        ].sort(),
      );
    });

    // Nothing about their access got shorter, so nothing is swapped out.
    it('keeps the session they came with', async () => {
      const invite = await makeInvite({
        cohortId,
        cohortRole: CohortRole.Mentor,
      });

      const res = await decide(member, InviteDecision.Accept, invite.id);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    // A provisional decline clears the cookie; a member stays signed in.
    it('stays signed in after declining', async () => {
      const invite = await makeInvite({
        cohortId,
        cohortRole: CohortRole.Mentor,
      });

      const res = await decide(member, InviteDecision.Decline, invite.id);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, invite.id));
      expect(row.status).toBe(InviteStatus.Declined);
    });

    it('must name the invite it answers', async () => {
      await makeInvite({ cohortId, cohortRole: CohortRole.Mentor });

      const res = await decide(member, InviteDecision.Accept);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { fields: { inviteId: expect.any(String) } },
      });
    });

    /**
     * Read invite A, admin swaps it for B, then click Accept: the member
     * answered A, so A's state is the answer — never B, which they never saw.
     */
    it('never accepts an invite that replaced the one it was shown', async () => {
      const shown = await makeInvite({
        cohortId,
        cohortRole: CohortRole.Mentor,
        status: InviteStatus.Revoked,
      });
      const replacement = await makeInvite({
        cohortId,
        systemRole: SystemRole.Admin,
        cohortRole: CohortRole.Professor,
      });

      const res = await decide(member, InviteDecision.Accept, shown.id);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVITE_REVOKED');
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, replacement.id));
      expect(row.status).toBe(InviteStatus.Pending);
      const [account] = await db
        .select()
        .from(users)
        .where(eq(users.id, inviteeId));
      expect(account.systemRole).toBe(SystemRole.User);
    });

    it('answers 404 for an invite addressed to somebody else', async () => {
      const [stranger] = await db
        .insert(users)
        .values({ email: 'someone.else@campus.local' })
        .returning();
      const theirs = await makeInvite({
        email: stranger.email,
        cohortId,
        cohortRole: CohortRole.Mentor,
      });

      const res = await decide(member, InviteDecision.Accept, theirs.id);

      expect(res.status).toBe(404);
    });
  });

  it('refuses a decision with no session', async () => {
    const res = await decide(undefined, InviteDecision.Accept);
    expect(res.status).toBe(401);
  });

  it('refuses a decision with no invite in the session', async () => {
    const bare = await cookieFor(
      inviteeId,
      inviteeEmail,
      SessionScope.Provisional,
    );
    const res = await decide(bare, InviteDecision.Accept);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown decision value', async () => {
    const invite = await makeInvite();
    const res = await decide(provisional(invite.id), 'maybe');
    expect(res.status).toBe(400);
  });

  it('clears the cookie on a decline', async () => {
    const invite = await makeInvite({
      cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId,
    });

    const res = await decide(provisional(invite.id), InviteDecision.Decline);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(InviteStatus.Declined);
    expect(res.body.membership).toBeNull();
    // decidedAt comes from the row's updated_at, which only works because
    // drizzle's $onUpdate fires on an explicit .update() and is returned.
    const decidedAt = new Date(res.body.decidedAt);
    expect(decidedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(decidedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // An emptied cookie, not an absent one: the browser has to be told.
    const setCookie = sessionCookieOf(res);
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));

    const members = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, inviteeId));
    expect(members).toHaveLength(0);
  });

  it('answers 409 on a replayed accept instead of re-issuing the cookie', async () => {
    const invite = await makeInvite({
      cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId,
    });

    const first = await decide(provisional(invite.id), InviteDecision.Accept);
    expect(first.status).toBe(200);

    // The decision stands. The caller is told which answer it was so it can
    // route them to sign-in, and gets no cookie: this response is not a
    // session upgrade. The code, not the 409, is what they branch on.
    const second = await decide(provisional(invite.id), InviteDecision.Accept);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
    expect(second.body.error.details).toMatchObject({
      inviteId: invite.id,
      status: InviteStatus.Accepted,
    });
    expect(sessionCookieOf(second)).toBeUndefined();

    // The first accept is untouched by the refused replay.
    const members = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, inviteeId));
    expect(members).toHaveLength(1);
  });

  it('answers 409 on a replayed decline with the declined status', async () => {
    const invite = await makeInvite();

    const first = await decide(provisional(invite.id), InviteDecision.Decline);
    expect(first.status).toBe(200);

    const second = await decide(provisional(invite.id), InviteDecision.Decline);
    expect(second.status).toBe(409);
    expect(second.body.error.details).toMatchObject({
      status: InviteStatus.Declined,
    });
  });

  it('refuses a lapsed invite', async () => {
    const invite = await makeInvite({
      expiresAt: new Date(Date.now() - 1_000),
    });
    const res = await decide(provisional(invite.id), InviteDecision.Accept);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');
  });

  it('answers 403 for a lapsed invite even once the status is materialised', async () => {
    const invite = await makeInvite({
      expiresAt: new Date(Date.now() - 1_000),
    });

    // Reading the invite first flips the lazy expiry, so the row now *says*
    // expired rather than being pending past its date. The answer must not
    // change just because something read it.
    const read = await request(app.getHttpServer())
      .get('/v1/invites/validate-user-invite')
      .set('Cookie', await provisional(invite.id));
    expect(read.status).toBe(403);

    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, invite.id));
    expect(row.status).toBe(InviteStatus.Expired);

    const res = await decide(provisional(invite.id), InviteDecision.Accept);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');
  });

  it('refuses to decline an invite that was accepted', async () => {
    const invite = await makeInvite();
    await decide(provisional(invite.id), InviteDecision.Accept);

    // Opposite decision, same code as a replayed accept: the fact is that an
    // answer already stands, not which one the caller just sent.
    const res = await decide(provisional(invite.id), InviteDecision.Decline);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
  });

  it('refuses a revoked invite with a code that closes the flow', async () => {
    const invite = await makeInvite({ status: InviteStatus.Revoked });

    const res = await decide(provisional(invite.id), InviteDecision.Accept);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_REVOKED');
  });

  it('applies an admin invite role to the account', async () => {
    const invite = await makeInvite({ systemRole: SystemRole.Admin });

    const res = await decide(provisional(invite.id), InviteDecision.Accept);

    expect(res.status).toBe(200);
    expect(res.body.systemRole).toBe(SystemRole.Admin);

    const [row] = await db.select().from(users).where(eq(users.id, inviteeId));
    expect(row.systemRole).toBe(SystemRole.Admin);
  });

  // The correlation id is what leads from an audit entry to the request's
  // log lines, so it has to survive the trip from the header to the row.
  it("audits an admin grant under the request's correlation id", async () => {
    const invite = await makeInvite({ systemRole: SystemRole.Admin });

    await request(app.getHttpServer())
      .post(URL_UNDER_TEST)
      .set('Cookie', await provisional(invite.id))
      .set('x-correlation-id', 'e2e-corr-1')
      .send({ decision: InviteDecision.Accept })
      .expect(200);

    const entries = await db.select().from(auditLog);
    expect(entries).toEqual([
      expect.objectContaining({
        action: AuditAction.SystemRoleChanged,
        actorUserId: inviteeId,
        correlationId: 'e2e-corr-1',
      }),
    ]);
  });
});
