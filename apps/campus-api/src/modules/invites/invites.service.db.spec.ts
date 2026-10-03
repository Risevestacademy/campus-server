import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import {
  CohortRole,
  CohortStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
  StudentStatus,
} from '../cohorts/schema.js';
import { CohortMembersService } from '../cohorts/cohort-members.service.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { InviteDecision } from './dto/invite-decision.dto.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';
import {
  InviteAlreadyAcceptedException,
  InviteAlreadyDeclinedException,
  InviteConflictException,
  InviteExpiredException,
  InviteForbiddenException,
  InviteInternalException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
  InviteRevokedException,
} from './invites.exceptions.js';
import {
  InvitesService,
  classifyInviteWriteError,
  isInviteLive,
} from './invites.service.js';
import { InviteStatus, invites } from './schema.js';

vi.mock('./invite-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invite-token.js')>();
  return { ...actual, generateInviteToken: vi.fn(actual.generateInviteToken) };
});

/**
 * Item 5 proof: the mocked unit spec can only feed the service errors it
 * wrote itself, so a drift in real Postgres violation text would ship a 500
 * with every test green. These run the service against a real engine
 * (PGlite, committed migrations applied) and assert against genuine
 * violations.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: {
    users,
    tracks,
    cohorts,
    cohortTracks,
    cohortMembers,
    invites,
    auditLog,
  },
});

const config = {
  APP_PUBLIC_URL: 'http://localhost:3000',
  INVITE_TTL_DAYS: 7,
} as never;

const service = new InvitesService(db as never, config);
const members = new CohortMembersService(db as never);
const inviter: AuthenticatedUser = {
  id: '',
  email: 'admin@campus.local',
  systemRole: SystemRole.Admin,
};

let fixtures: { cohortId: string; cohortTrackId: string };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate audit_log, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [admin] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  inviter.id = admin.id;

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

  fixtures = { cohortId: cohort.id, cohortTrackId: link.id };
});

describe('InvitesService against real Postgres', () => {
  it('stores only the hash and returns a link embedding the raw token', async () => {
    const res = await service.create(
      {
        email: 'student@campus.local',
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const [row] = await db
      .select()
      .from(invites)
      .where(sql`${invites.id} = ${res.id}`);
    expect(row.tokenHash).toBe(
      createHash('sha256').update(res.token, 'utf8').digest('hex'),
    );
    expect(row.tokenHash).not.toContain(res.token);
    expect(res.inviteLink).toContain(encodeURIComponent(res.token));
  });

  it('accepts a cohort-scoped guest invite end to end', async () => {
    const res = await service.create(
      {
        email: 'guest@campus.local',
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Guest,
        guestAccessExpiresAt: new Date(
          Date.now() + 7 * 86_400_000,
        ).toISOString(),
      },
      inviter,
    );
    // A guest is a cohort role: the invite names the cohort they will see,
    // and the date their visit ends.
    expect(res).toMatchObject({
      systemRole: SystemRole.User,
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Guest,
    });
  });

  /**
   * The link must not outlive the visit. Without the clamp an admin could
   * offer a window ending tomorrow while the invite stayed redeemable for
   * INVITE_TTL_DAYS — accepting on day three would mint a full-access
   * session against a membership that was already over.
   */
  it('never lets the link outlive the visit it grants', async () => {
    const endsAt = new Date(Date.now() + 3_600_000);
    const res = await service.create(
      {
        email: 'brief@campus.local',
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Guest,
        guestAccessExpiresAt: endsAt.toISOString(),
      },
      inviter,
    );

    expect(res.expiresAt).toBe(endsAt.toISOString());
    expect(res.guestAccessExpiresAt).toBe(endsAt.toISOString());
  });

  // The admin who sets the window has to be able to see it on the receipt,
  // or there is no way to confirm what was offered.
  it('leaves guestAccessExpiresAt null on a receipt for anybody else', async () => {
    const res = await service.create(
      {
        email: 'prof@campus.local',
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
      },
      inviter,
    );

    expect(res.guestAccessExpiresAt).toBeNull();
  });

  it('refuses an end date that is not a date', async () => {
    await expect(
      service.create(
        {
          email: 'guest@campus.local',
          cohortId: fixtures.cohortId,
          cohortRole: CohortRole.Guest,
          guestAccessExpiresAt: 'whenever',
        },
        inviter,
      ),
    ).rejects.toThrow(/not a valid date/);
  });

  it('refuses an end date already in the past', async () => {
    await expect(
      service.create(
        {
          email: 'guest@campus.local',
          cohortId: fixtures.cohortId,
          cohortRole: CohortRole.Guest,
          guestAccessExpiresAt: new Date(Date.now() - 1000).toISOString(),
        },
        inviter,
      ),
    ).rejects.toThrow(/must be in the future/);
  });

  it('refuses a guest invite that never ends', async () => {
    await expect(
      service.create(
        {
          email: 'openended@campus.local',
          cohortId: fixtures.cohortId,
          cohortRole: CohortRole.Guest,
        },
        inviter,
      ),
    ).rejects.toThrow(/guestAccessExpiresAt is required/);
  });

  it('refuses an end date on a role that is not a guest', async () => {
    await expect(
      service.create(
        {
          email: 'prof@campus.local',
          cohortId: fixtures.cohortId,
          cohortRole: CohortRole.Professor,
          guestAccessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        inviter,
      ),
    ).rejects.toThrow(/guest invites only/);
  });

  /** The shape that used to strand people: no cohort, no admin role. */
  it('refuses an invite that belongs to no cohort and grants nothing', async () => {
    await expect(
      service.create({ email: 'nowhere@campus.local' }, inviter),
    ).rejects.toThrow(/may omit a cohort/);
  });

  it('rejects a second pending invite for the same address (409)', async () => {
    await service.create(
      { email: 'dup@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    const err = await service
      .create(
        { email: 'dup@campus.local', systemRole: SystemRole.Admin },
        inviter,
      )
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(InviteConflictException);
    expect((err as InviteConflictException).code).toBe('CONFLICT');
  });

  it('classifies a genuine duplicate-key violation as pending-duplicate', async () => {
    await db.insert(invites).values({
      email: 'raw@campus.local',
      tokenHash: 'hash-one',
      invitedBy: inviter.id,
      systemRole: SystemRole.Admin,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const raw = await db
      .insert(invites)
      .values({
        email: 'raw@campus.local',
        tokenHash: 'hash-two',
        invitedBy: inviter.id,
        systemRole: SystemRole.Admin,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .catch((caught: unknown) => caught);

    // The assertion that matters: drizzle wraps the driver error, so the
    // outer message is just "Failed query: ..." — SQLSTATE 23505 and the
    // constraint name live on `cause`. The service must match there; if the
    // driver ever changes this shape, this test (not production) breaks first.
    const cause = (raw as { cause?: { code?: unknown; constraint?: unknown } })
      ?.cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint).toBe('invites_email_pending_unique');
    expect(classifyInviteWriteError(raw)).toBe('pending-duplicate');
  });

  it('retries against a genuine token-hash collision', async () => {
    const pinned = 'pinned-raw-token';
    await db.insert(invites).values({
      email: 'first@campus.local',
      tokenHash: hashInviteToken(pinned),
      invitedBy: inviter.id,
      systemRole: SystemRole.Admin,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    vi.mocked(generateInviteToken).mockReturnValueOnce(pinned);
    const res = await service.create(
      { email: 'second@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.token).not.toBe(pinned);
    expect(res.email).toBe('second@campus.local');
  });

  it('re-invites a lapsed address and flips the stale row to expired', async () => {
    await db.insert(invites).values({
      email: 'stale@campus.local',
      tokenHash: 'stale-hash',
      invitedBy: inviter.id,
      systemRole: SystemRole.Admin,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = await service.create(
      { email: 'stale@campus.local', systemRole: SystemRole.Admin },
      inviter,
    );
    expect(res.email).toBe('stale@campus.local');

    const rows = await db
      .select({ status: invites.status })
      .from(invites)
      .where(sql`${invites.email} = 'stale@campus.local'`);
    expect(rows.map((row) => row.status).sort()).toEqual(
      [InviteStatus.Expired, InviteStatus.Pending].sort(),
    );
  });

  it('treats expires_at as the source of truth on read', () => {
    expect(
      isInviteLive({
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(true);
    expect(
      isInviteLive({
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).toBe(false);
    expect(
      isInviteLive({
        status: InviteStatus.Revoked,
        expiresAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(false);
  });

  it('still rejects mismatched cohort/role pairs before touching the DB', async () => {
    await expect(
      service.create(
        {
          email: 'x@campus.local',
          cohortId: fixtures.cohortId,
          systemRole: SystemRole.Admin,
        },
        inviter,
      ),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });
});

/**
 * getOnboardingInvite is the only read path that crosses from a session to
 * invite rows, so it is exercised against real Postgres rather than a mock:
 * the join shape, the nullable cohort columns for guest invites, and the
 * lazy status flip are all things a mocked db can only agree with.
 */
/**
 * A person can belong to several cohorts, so being a member never stands in
 * the way of an invite — except to the cohort they are already in, which
 * accept could never honour.
 */
describe('create() for somebody who is already a member', () => {
  const studentInvite = (email: string) => ({
    email,
    cohortId: fixtures.cohortId,
    cohortRole: CohortRole.Student,
    cohortTrackId: fixtures.cohortTrackId,
  });

  const enrol = async (
    overrides: Partial<typeof cohortMembers.$inferInsert> = {},
  ) => {
    const [user] = await db
      .insert(users)
      .values({ email: 'member@campus.local' })
      .returning();
    await db.insert(cohortMembers).values({
      cohortId: fixtures.cohortId,
      userId: user.id,
      role: CohortRole.Mentor,
      ...overrides,
    });
    return user;
  };

  it('refuses an invite to the cohort they are already in', async () => {
    const member = await enrol();

    await expect(
      service.create(studentInvite(member.email), inviter),
    ).rejects.toBeInstanceOf(InviteConflictException);
    expect(await db.select().from(invites)).toHaveLength(0);
  });

  it('invites them to another cohort', async () => {
    const member = await enrol();
    const [other] = await db
      .insert(cohorts)
      .values({ name: 'Cohort 2', code: 'C2' })
      .returning();

    await expect(
      service.create(
        {
          email: member.email,
          cohortId: other.id,
          cohortRole: CohortRole.Professor,
        },
        inviter,
      ),
    ).resolves.toMatchObject({ cohortId: other.id });
  });

  it('invites them back once their membership has ended', async () => {
    const member = await enrol({ leftAt: new Date() });

    await expect(
      service.create(studentInvite(member.email), inviter),
    ).resolves.toMatchObject({ cohortId: fixtures.cohortId });
  });
});

describe('getOnboardingInvite', () => {
  const seedInvitee = async (
    email = 'invitee@campus.local',
  ): Promise<AuthenticatedUser> => {
    const [user] = await db
      .insert(users)
      .values({ email, systemRole: SystemRole.User })
      .returning();
    return { id: user.id, email: user.email, systemRole: user.systemRole };
  };

  /**
   * Dates are Date, not string. The db spec calls the service directly, so
   * this is the only place the real in-memory types are observable — the e2e
   * can only see the ISO text JSON.stringify produced on the way out.
   */
  it('returns timestamps as Date and DATE columns as plain text', async () => {
    const invitee = await seedInvitee();
    await db
      .update(cohorts)
      .set({ startDate: '2026-09-01', endDate: '2027-06-30' })
      .where(sql`${cohorts.id} = ${fixtures.cohortId}`);
    const created = await service.create(
      {
        email: invitee.email,
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const res = await service.getOnboardingInvite(created.id, invitee);

    expect(res.expiresAt).toBeInstanceOf(Date);
    expect(res.createdAt).toBeInstanceOf(Date);
    expect(res.cohort?.createdAt).toBeInstanceOf(Date);
    expect(res.cohort?.updatedAt).toBeInstanceOf(Date);
    expect(res.cohortTrack?.createdAt).toBeInstanceOf(Date);
    expect(res.track?.createdAt).toBeInstanceOf(Date);
    expect(res.user.createdAt).toBeInstanceOf(Date);

    // The driver hands back DATE columns as 'YYYY-MM-DD' text, and widening
    // that to Date would assert an instant the value does not carry.
    expect(res.cohort?.startDate).toBe('2026-09-01');
    expect(res.cohort?.endDate).toBe('2027-06-30');
    expect(res.cohort?.startDate).not.toBeInstanceOf(Date);
  });

  it('returns cohort, track and both roles for a live cohort invite', async () => {
    const invitee = await seedInvitee();
    const created = await service.create(
      {
        email: invitee.email,
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const res = await service.getOnboardingInvite(created.id, invitee);

    expect(res.id).toBe(created.id);
    expect(res.cohort?.id).toBe(fixtures.cohortId);
    expect(res.cohort?.name).toBe('Cohort 1');
    expect(res.cohort?.code).toBe('C1');
    expect(res.cohortTrack?.id).toBe(fixtures.cohortTrackId);
    expect(res.track?.name).toBe('Software Engineering');
    expect(res.track?.code).toBe('SE');
    expect(res.cohortRole).toBe(CohortRole.Student);
    expect(res.systemRole).toBe(SystemRole.User);
    expect(res.status).toBe(InviteStatus.Pending);
    expect(res.invitedBy.id).toBe(inviter.id);
    // The shared admin fixture has no name parts, so both stay null rather
    // than being invented from the address.
    expect(res.invitedBy).toEqual({
      id: inviter.id,
      firstName: null,
      lastName: null,
    });
    expect(res.user.id).toBe(invitee.id);
    expect(res.user.email).toBe(invitee.email);
    // created.expiresAt is the create receipt's ISO text; this is the same
    // instant, still a Date here.
    expect(res.expiresAt.getTime()).toBe(new Date(created.expiresAt).getTime());
  });

  /**
   * Why the DTO promises Date rather than string: a value whose toJSON threw
   * would serialise as null and silently drop out of the payload, which is how
   * a field declared "string, always" turns into a consumer reading undefined.
   * The ISO shape below is what the wire actually carries.
   */
  it('serialises the Date fields to ISO text on the wire', async () => {
    const invitee = await seedInvitee();
    const created = await service.create(
      {
        email: invitee.email,
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const res = await service.getOnboardingInvite(created.id, invitee);
    const wire = JSON.parse(JSON.stringify(res));
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    expect(wire.expiresAt).toBe(new Date(created.expiresAt).toISOString());
    expect(wire.createdAt).toMatch(iso);
    expect(wire.cohort.createdAt).toMatch(iso);
    expect(wire.cohort.updatedAt).toMatch(iso);
    expect(wire.cohortTrack.createdAt).toMatch(iso);
    expect(wire.track.createdAt).toMatch(iso);
    expect(wire.user.createdAt).toMatch(iso);
  });

  /** The populated case, since the shared fixture has no name parts. */
  it('returns the inviter name parts when they are set', async () => {
    const [named] = await db
      .insert(users)
      .values({
        email: 'ada@campus.local',
        systemRole: SystemRole.Admin,
        firstName: 'Ada',
        lastName: 'Lovelace',
      })
      .returning();
    const invitee = await seedInvitee('named-invitee@campus.local');
    const created = await service.create(
      { email: invitee.email, systemRole: SystemRole.Admin },
      named,
    );

    const res = await service.getOnboardingInvite(created.id, invitee);

    expect(res.invitedBy).toEqual({
      id: named.id,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('never leaks the token, the link or the invited address', async () => {
    const invitee = await seedInvitee();
    const created = await service.create(
      {
        email: invitee.email,
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
      },
      inviter,
    );

    const wire = JSON.stringify(
      await service.getOnboardingInvite(created.id, invitee),
    );

    expect(wire).not.toContain(created.token);
    expect(wire).not.toContain('inviteLink');
    expect(wire).not.toContain('tokenHash');
  });

  it('returns nulls for the cohort shape of an admin invite', async () => {
    const invitee = await seedInvitee('guest-invitee@campus.local');
    const created = await service.create(
      { email: invitee.email, systemRole: SystemRole.Admin },
      inviter,
    );

    const res = await service.getOnboardingInvite(created.id, invitee);

    expect(res.cohort).toBeNull();
    expect(res.cohortTrack).toBeNull();
    expect(res.track).toBeNull();
    expect(res.cohortRole).toBeNull();
    expect(res.systemRole).toBe(SystemRole.Admin);
  });

  it('404s on an id that matches nothing', async () => {
    const invitee = await seedInvitee();
    await expect(
      service.getOnboardingInvite(
        '00000000-0000-4000-8000-000000000000',
        invitee,
      ),
    ).rejects.toBeInstanceOf(InviteNotFoundException);
  });

  /**
   * The second identifier. A session can only be signed with an invite the
   * app minted, so a mismatch is unreachable by a caller — it is a bug, and
   * it must not be laundered into a 404 that blames the user.
   */
  it('500s when the invite is addressed to a different account', async () => {
    const owner = await seedInvitee('owner@campus.local');
    const impostor = await seedInvitee('impostor@campus.local');
    const created = await service.create(
      { email: owner.email, systemRole: SystemRole.Admin },
      inviter,
    );

    await expect(
      service.getOnboardingInvite(created.id, impostor),
    ).rejects.toBeInstanceOf(InviteInternalException);
  });

  it('403s a lapsed invite and materialises the status flip', async () => {
    const invitee = await seedInvitee();
    const created = await service.create(
      { email: invitee.email, systemRole: SystemRole.Admin },
      inviter,
    );
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(sql`${invites.id} = ${created.id}`);

    await expect(
      service.getOnboardingInvite(created.id, invitee),
    ).rejects.toBeInstanceOf(InviteExpiredException);

    const [row] = await db
      .select({ status: invites.status })
      .from(invites)
      .where(sql`${invites.id} = ${created.id}`);
    expect(row.status).toBe(InviteStatus.Expired);
  });

  it('409s a resolved invite with its own code and leaves its status alone', async () => {
    const invitee = await seedInvitee();
    const created = await service.create(
      { email: invitee.email, systemRole: SystemRole.Admin },
      inviter,
    );
    await db
      .update(invites)
      .set({ status: InviteStatus.Declined })
      .where(sql`${invites.id} = ${created.id}`);

    await expect(
      service.getOnboardingInvite(created.id, invitee),
    ).rejects.toBeInstanceOf(InviteAlreadyDeclinedException);

    const [row] = await db
      .select({ status: invites.status })
      .from(invites)
      .where(sql`${invites.id} = ${created.id}`);
    expect(row.status).toBe(InviteStatus.Declined);
  });

  /**
   * The conditional part of expireLazily's UPDATE, called directly.
   *
   * Reaching it through getOnboardingInvite cannot cover it: a row whose
   * status already moved on short-circuits into the 409 branch and never
   * issues the write. The race being defended against is the update landing
   * after a concurrent accept, so the assertion has to be about the UPDATE's
   * own WHERE clause — which is why this is the one test reaching past the
   * public surface. Verified by deleting either guard: both fail.
   */
  /**
   * The first read materialises the lapse, so the second sees a different
   * stored status. The caller did nothing differently and must not be told
   * anything different.
   */
  it('answers a lapsed invite the same way however often it is asked', async () => {
    const [invitee] = await db
      .insert(users)
      .values({ email: 'lapsed@campus.local' })
      .returning();
    const [invite] = await db
      .insert(invites)
      .values({
        email: invitee.email,
        invitedBy: inviter.id,
        tokenHash: hashInviteToken(generateInviteToken()),
        systemRole: SystemRole.Admin,
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      .returning();

    const codes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await service
        .getOnboardingInvite(invite.id, invitee as never)
        .catch((err: { code: string }) => codes.push(err.code));
    }

    expect(codes).toEqual(['INVITE_EXPIRED', 'INVITE_EXPIRED']);

    // And the decision route agrees with both of them.
    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED' });
  });

  describe('expireLazily guards', () => {
    const expireLazily = (id: string, now = new Date()) =>
      (
        service as unknown as {
          expireLazily(id: string, now?: Date): Promise<void>;
        }
      ).expireLazily(id, now);

    const statusOf = async (id: string) => {
      const [row] = await db
        .select({ status: invites.status })
        .from(invites)
        .where(sql`${invites.id} = ${id}`);
      return row.status;
    };

    it('flips a still-pending lapsed invite', async () => {
      const invitee = await seedInvitee('flip@campus.local');
      const created = await service.create(
        { email: invitee.email, systemRole: SystemRole.Admin },
        inviter,
      );
      const past = new Date(Date.now() - 1_000);
      await db
        .update(invites)
        .set({ expiresAt: past })
        .where(sql`${invites.id} = ${created.id}`);

      await expireLazily(created.id);

      expect(await statusOf(created.id)).toBe(InviteStatus.Expired);
    });

    /** The accept-wins half: a status that moved on must survive untouched. */
    it('leaves an accepted invite alone', async () => {
      const invitee = await seedInvitee('accepted@campus.local');
      const created = await service.create(
        { email: invitee.email, systemRole: SystemRole.Admin },
        inviter,
      );
      await db
        .update(invites)
        .set({
          status: InviteStatus.Accepted,
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(sql`${invites.id} = ${created.id}`);

      await expireLazily(created.id);

      expect(await statusOf(created.id)).toBe(InviteStatus.Accepted);
    });

    /** And the lapsed-not-yet-expired half, so a live offer is never buried. */
    it('leaves a still-live invite alone', async () => {
      const invitee = await seedInvitee('live@campus.local');
      const created = await service.create(
        { email: invitee.email, systemRole: SystemRole.Admin },
        inviter,
      );

      await expireLazily(created.id);

      expect(await statusOf(created.id)).toBe(InviteStatus.Pending);
    });
  });
});

describe('decide()', () => {
  const eqId = (id: string) => eq(invites.id, id);
  const eqUser = (id: string) => eq(users.id, id);

  let invitee: AuthenticatedUser;

  const statusOfInvite = async (id: string) => {
    const [row] = await db.select().from(invites).where(eqId(id));
    return row.status;
  };

  beforeEach(async () => {
    const [row] = await db
      .insert(users)
      .values({ email: 'invitee@campus.local' })
      .returning();
    invitee = {
      id: row.id,
      email: row.email,
      systemRole: row.systemRole,
    };
  });

  const makeInvite = async (
    overrides: Partial<typeof invites.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(invites)
      .values({
        email: invitee.email,
        invitedBy: inviter.id,
        tokenHash: hashInviteToken(generateInviteToken()),
        expiresAt: new Date(Date.now() + 86_400_000),
        // invites_cohortless_is_admin: an invite with no cohort can only be
        // an admin one, so that is what a bare fixture means.
        systemRole:
          overrides.cohortId == null ? SystemRole.Admin : SystemRole.User,
        ...overrides,
      })
      .returning();
    return row;
  };

  const membershipOf = async (userId: string) => {
    const rows = await db.select().from(cohortMembers);
    return rows.filter((r) => r.userId === userId);
  };

  /**
   * An invite is an offer, not an instruction to overwrite. Somebody can hold
   * a provisional session, be promoted elsewhere, and only then accept.
   */
  it('never lowers a role somebody already holds', async () => {
    await db
      .update(users)
      .set({ systemRole: SystemRole.Admin })
      .where(eqUser(invitee.id));
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
      systemRole: SystemRole.User,
    });

    const outcome = await service.decide(invite.id, InviteDecision.Accept, {
      ...invitee,
      systemRole: SystemRole.Admin,
    } as never);

    expect(outcome.response.systemRole).toBe(SystemRole.Admin);
    const [row] = await db.select().from(users).where(eqUser(invitee.id));
    expect(row.systemRole).toBe(SystemRole.Admin);
  });

  it('still raises an ordinary account when the invite says admin', async () => {
    const invite = await makeInvite({ systemRole: SystemRole.Admin });

    await service.decide(invite.id, InviteDecision.Accept, invitee as never);

    const [row] = await db.select().from(users).where(eqUser(invitee.id));
    expect(row.systemRole).toBe(SystemRole.Admin);
  });

  /**
   * Reviving a membership is for people who left. A live one belongs to a
   * decision somebody already made, and a stale invite must not rewrite it.
   */
  it('refuses to overwrite a membership that is still running', async () => {
    const [live] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Professor,
        joinedAt: new Date('2020-01-01T00:00:00.000Z'),
      })
      .returning();
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toThrow(InviteConflictException);

    const [unchanged] = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.id, live.id));
    expect(unchanged).toMatchObject({
      role: CohortRole.Professor,
      joinedAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    // The whole accept rolls back, so the invite is still answerable.
    const [row] = await db.select().from(invites).where(eqId(invite.id));
    expect(row.status).toBe(InviteStatus.Pending);
  });

  it('revives a membership somebody left', async () => {
    const [departed] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Student,
        status: StudentStatus.Graduated,
        joinedAt: new Date('2020-01-01T00:00:00.000Z'),
        leftAt: new Date('2021-01-01T00:00:00.000Z'),
      })
      .returning();
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    await service.decide(invite.id, InviteDecision.Accept, invitee as never);

    const [revived] = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.id, departed.id));
    expect(revived).toMatchObject({
      leftAt: null,
      status: StudentStatus.Active,
    });
    expect(await membershipOf(invitee.id)).toHaveLength(1);
  });

  it('accepts a student invite, enrolling them with an active status', async () => {
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    const outcome = await service.decide(
      invite.id,
      InviteDecision.Accept,
      invitee as never,
    );

    expect(outcome.kind).toBe('accepted');
    expect(outcome.response.status).toBe(InviteStatus.Accepted);

    const [row] = await db.select().from(invites).where(eqId(invite.id));
    expect(row.status).toBe(InviteStatus.Accepted);
    expect(row.acceptedAt).toBeInstanceOf(Date);

    const [member] = await membershipOf(invitee.id);
    expect(member.cohortId).toBe(fixtures.cohortId);
    expect(member.role).toBe(CohortRole.Student);
    expect(member.cohortTrackId).toBe(fixtures.cohortTrackId);
    // The trap: hasActiveMembership only counts a student whose status is
    // active, so a null here would strand them at the invite wall.
    expect(member.status).toBe(StudentStatus.Active);
    expect(member.leftAt).toBeNull();
  });

  it('applies the invite systemRole to the account on accept', async () => {
    const invite = await makeInvite({ systemRole: SystemRole.Admin });

    const outcome = await service.decide(
      invite.id,
      InviteDecision.Accept,
      invitee as never,
    );

    expect(outcome.kind).toBe('accepted');
    expect(outcome.response.systemRole).toBe(SystemRole.Admin);

    const [row] = await db.select().from(users).where(eqUser(invitee.id));
    expect(row.systemRole).toBe(SystemRole.Admin);
  });

  /** An admin invite is the only one with nobody to enrol. */
  it('accepts an admin invite without enrolling anyone', async () => {
    const invite = await makeInvite();

    const outcome = await service.decide(
      invite.id,
      InviteDecision.Accept,
      invitee as never,
    );

    expect(outcome.response.membership).toBeNull();
    expect(await membershipOf(invitee.id)).toHaveLength(0);
    expect(outcome.response.systemRole).toBe(SystemRole.Admin);
  });

  /**
   * The lockout this model exists to remove: a guest enrols like anybody
   * else, so the sign-in gate recognises them on their next visit.
   */
  it('enrols a guest, with the end date their invite carried', async () => {
    const endsAt = new Date(Date.now() + 7 * 86_400_000);
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Guest,
      guestAccessExpiresAt: endsAt,
    });

    const outcome = await service.decide(
      invite.id,
      InviteDecision.Accept,
      invitee as never,
    );

    expect(outcome.response.membership).toMatchObject({
      role: CohortRole.Guest,
    });
    const [membership] = await membershipOf(invitee.id);
    expect(membership.accessExpiresAt?.toISOString()).toBe(
      endsAt.toISOString(),
    );
    expect(membership.status).toBeNull();
  });

  it('leaves status null for a non-student role', async () => {
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
    });

    await service.decide(invite.id, InviteDecision.Accept, invitee as never);

    const [member] = await membershipOf(invitee.id);
    expect(member.role).toBe(CohortRole.Professor);
    expect(member.status).toBeNull();
  });

  it('refuses to decide an invite that already carries an answer', async () => {
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    const first = await service.decide(
      invite.id,
      InviteDecision.Accept,
      invitee as never,
    );
    expect(first.kind).toBe('accepted');

    // The retry is a conflict, not a repeat: the caller is told which answer
    // already stands so it can route them, rather than being handed a second
    // session for a decision it already made.
    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedException);

    // ...and the replay did not enrol them twice.
    expect(await membershipOf(invitee.id)).toHaveLength(1);
  });

  it('names the standing answer in a code the caller can branch on', async () => {
    const accepted = await makeInvite();
    await service.decide(accepted.id, InviteDecision.Accept, invitee as never);
    await expect(
      service.decide(accepted.id, InviteDecision.Accept, invitee as never),
    ).rejects.toMatchObject({
      code: 'INVITE_ALREADY_ACCEPTED',
      details: { inviteId: accepted.id, status: InviteStatus.Accepted },
    });

    const declined = await makeInvite({ email: invitee.email });
    await service.decide(declined.id, InviteDecision.Decline, invitee as never);
    await expect(
      service.decide(declined.id, InviteDecision.Decline, invitee as never),
    ).rejects.toMatchObject({
      code: 'INVITE_ALREADY_DECLINED',
      details: { inviteId: declined.id, status: InviteStatus.Declined },
    });

    const revoked = await makeInvite({ email: invitee.email });
    await db
      .update(invites)
      .set({ status: InviteStatus.Revoked })
      .where(sql`${invites.id} = ${revoked.id}`);
    await expect(
      service.decide(revoked.id, InviteDecision.Accept, invitee as never),
    ).rejects.toMatchObject({
      code: 'INVITE_REVOKED',
      details: { inviteId: revoked.id, status: InviteStatus.Revoked },
    });
  });

  it('revives a membership a former member had left', async () => {
    const [stale] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        role: CohortRole.Student,
        cohortTrackId: fixtures.cohortTrackId,
        status: StudentStatus.Withdrawn,
        leftAt: new Date(),
      })
      .returning();
    expect(stale.leftAt).toBeInstanceOf(Date);

    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });
    await service.decide(invite.id, InviteDecision.Accept, invitee as never);

    // One row per person per cohort, ever — revived, not duplicated.
    const rows = await membershipOf(invitee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].leftAt).toBeNull();
    expect(rows[0].status).toBe(StudentStatus.Active);
  });

  it('declines without enrolling', async () => {
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    const first = await service.decide(
      invite.id,
      InviteDecision.Decline,
      invitee as never,
    );
    expect(first.kind).toBe('declined');
    expect(first.response.membership).toBeNull();
    expect(first.response.systemRole).toBeNull();
    expect(await membershipOf(invitee.id)).toHaveLength(0);

    const [row] = await db.select().from(invites).where(eqId(invite.id));
    expect(row.status).toBe(InviteStatus.Declined);
  });

  it('leaves the account row in place after a decline', async () => {
    const invite = await makeInvite();
    await service.decide(invite.id, InviteDecision.Decline, invitee as never);

    const [row] = await db.select().from(users).where(eqUser(invitee.id));
    expect(row).toBeDefined();
  });

  it('refuses a decision on an invite already accepted', async () => {
    const invite = await makeInvite();
    await service.decide(invite.id, InviteDecision.Accept, invitee as never);

    await expect(
      service.decide(invite.id, InviteDecision.Decline, invitee as never),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedException);
  });

  it('refuses a decision on an invite already declined', async () => {
    const invite = await makeInvite();
    await service.decide(invite.id, InviteDecision.Decline, invitee as never);

    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toBeInstanceOf(InviteAlreadyDeclinedException);
  });

  it('refuses a lapsed invite and leaves it pending for the read path', async () => {
    const invite = await makeInvite({
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toBeInstanceOf(InviteExpiredException);

    // The claim's throw rolls the transaction back, so the lazy flip is left
    // to getOnboardingInvite rather than half-applied here.
    const [row] = await db.select().from(invites).where(eqId(invite.id));
    expect(row.status).toBe(InviteStatus.Pending);
    expect(await membershipOf(invitee.id)).toHaveLength(0);
  });

  it('refuses a revoked invite', async () => {
    const invite = await makeInvite({ status: InviteStatus.Revoked });

    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee as never),
    ).rejects.toBeInstanceOf(InviteRevokedException);
  });

  it('refuses an unknown invite', async () => {
    await expect(
      service.decide(
        '00000000-0000-4000-8000-000000000000',
        InviteDecision.Accept,
        invitee as never,
      ),
    ).rejects.toBeInstanceOf(InviteNotFoundException);
  });

  it('refuses a session pointed at someone else invite as a server fault', async () => {
    const invite = await makeInvite();

    await expect(
      service.decide(invite.id, InviteDecision.Accept, {
        id: invitee.id,
        email: 'someone-else@campus.local',
        systemRole: SystemRole.User,
      } as never),
    ).rejects.toBeInstanceOf(InviteInternalException);
  });

  it('rolls the whole accept back when enrolment cannot complete', async () => {
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });

    // Email matches so the claim proceeds, but the account id does not exist,
    // so the membership insert trips cohort_members_user_id FK. A partial
    // accept here would burn the invite without enrolling anyone.
    await expect(
      service.decide(invite.id, InviteDecision.Accept, {
        id: '00000000-0000-4000-8000-000000000000',
        email: invitee.email,
        systemRole: SystemRole.User,
      } as never),
    ).rejects.toThrow();

    const [row] = await db.select().from(invites).where(eqId(invite.id));
    expect(row.status).toBe(InviteStatus.Pending);
    expect(row.acceptedAt).toBeNull();
  });
  /**
   * The guest lifecycle, end to end. Every one of these went green against
   * the first implementation while the feature was broken, which is why they
   * assert on the state a guest is actually left in rather than on the call
   * returning.
   */
  describe('guest visits', () => {
    const guestInvite = (endsAt: Date) =>
      makeInvite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Guest,
        guestAccessExpiresAt: endsAt,
      });

    /**
     * A visit that runs out leaves left_at NULL, so the revive guard has to
     * treat a lapsed window as "no longer live" too. Without that the row
     * blocks every future invite to the cohort and the guest can never be
     * asked back — the same dead end the cohort-role model was built to
     * remove, wearing a different hat.
     */
    it('lets a guest whose visit ended be invited back', async () => {
      const ended = new Date(Date.now() + 500);
      await service.decide(
        (await guestInvite(ended)).id,
        InviteDecision.Accept,
        invitee,
      );

      const later = new Date(Date.now() + 60_000);
      const nextEnd = new Date(Date.now() + 86_400_000);
      const second = await guestInvite(nextEnd);

      const outcome = await service.decide(
        second.id,
        InviteDecision.Accept,
        invitee,
        later,
      );

      expect(outcome.response.status).toBe(InviteStatus.Accepted);
      const [row] = await membershipOf(invitee.id);
      expect(row.accessExpiresAt?.toISOString()).toBe(nextEnd.toISOString());
      expect(row.leftAt).toBeNull();
      expect(await members.hasActiveMembership(invitee.id, later)).toBe(true);
    });

    // The other half of the same guard: a visit still running is a standing
    // decision, and a second invite must not quietly rewrite it.
    it('refuses to overwrite a visit that is still running', async () => {
      const endsAt = new Date(Date.now() + 86_400_000);
      await service.decide(
        (await guestInvite(endsAt)).id,
        InviteDecision.Accept,
        invitee,
      );
      const second = await guestInvite(new Date(Date.now() + 172_800_000));

      await expect(
        service.decide(second.id, InviteDecision.Accept, invitee),
      ).rejects.toBeInstanceOf(InviteConflictException);

      const [row] = await membershipOf(invitee.id);
      expect(row.accessExpiresAt?.toISOString()).toBe(endsAt.toISOString());
      expect(await statusOfInvite(second.id)).toBe(InviteStatus.Pending);
    });

    /**
     * Belt to create()'s braces: a row whose window closed before it was
     * answered must not produce a membership, because the accept would
     * otherwise report success and hand back a session the next sign-in
     * refuses.
     */
    it('refuses an accept once the window has closed', async () => {
      const invite = await guestInvite(new Date(Date.now() - 1000));

      await expect(
        service.decide(invite.id, InviteDecision.Accept, invitee),
      ).rejects.toBeInstanceOf(InviteForbiddenException);

      expect(await membershipOf(invitee.id)).toHaveLength(0);
      expect(await statusOfInvite(invite.id)).toBe(InviteStatus.Pending);
    });

    // The accept receipt has to carry the end date, or a client cannot tell
    // a visitor how long they are here for.
    it('reports the end date on the membership it grants', async () => {
      const endsAt = new Date(Date.now() + 86_400_000);
      const outcome = await service.decide(
        (await guestInvite(endsAt)).id,
        InviteDecision.Accept,
        invitee,
      );

      expect(outcome.response.membership?.accessExpiresAt?.toISOString()).toBe(
        endsAt.toISOString(),
      );
    });
  });

  /**
   * The revival rule and the sign-in rule are one predicate, and these pin
   * that down for the statuses where they used to disagree. A student who
   * cannot sign in but also cannot be re-invited has no way through at all
   * — the same dead end the guest model was built to remove, reached by a
   * different route.
   *
   * left_at is deliberately NULL in each: the TRD says a departure sets it,
   * but nothing enforces that, and these are exactly the rows where nobody
   * did.
   */
  describe.each([
    [StudentStatus.Dismissed, 'dismissed'],
    [StudentStatus.Withdrawn, 'withdrawn'],
    [StudentStatus.Deferred, 'deferred'],
    [StudentStatus.Graduated, 'graduated'],
    [null, 'never classified'],
  ])('a student left %s with no left_at', (status, label) => {
    it(`cannot sign in, and can still be re-invited (${label})`, async () => {
      await db.insert(cohortMembers).values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Student,
        status,
        leftAt: null,
      });
      expect(await members.hasActiveMembership(invitee.id)).toBe(false);

      const invite = await makeInvite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
      });
      const outcome = await service.decide(
        invite.id,
        InviteDecision.Accept,
        invitee,
      );

      expect(outcome.response.status).toBe(InviteStatus.Accepted);
      const [row] = await membershipOf(invitee.id);
      expect(row.role).toBe(CohortRole.Professor);
      expect(await members.hasActiveMembership(invitee.id)).toBe(true);
    });
  });

  /**
   * Access lasts while any live membership does, so a guest visit ending
   * must not shorten a session the holder's other, unexpiring membership
   * already justifies.
   */
  it('reports no deadline when one live membership never expires', async () => {
    await db.insert(cohortMembers).values({
      cohortId: fixtures.cohortId,
      userId: invitee.id,
      role: CohortRole.Professor,
    });
    const [other] = await db
      .insert(cohorts)
      .values({ name: 'C2', code: 'C2', status: CohortStatus.Active })
      .returning();
    await db.insert(cohortMembers).values({
      cohortId: other.id,
      userId: invitee.id,
      role: CohortRole.Guest,
      accessExpiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(await members.resolveActiveAccess(invitee.id)).toEqual({
      endsAt: null,
    });
  });

  // Two visits and nothing else: the session lasts until the later one ends.
  it('reports the last deadline when every membership has one', async () => {
    const soon = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 7_200_000);
    await db.insert(cohortMembers).values({
      cohortId: fixtures.cohortId,
      userId: invitee.id,
      role: CohortRole.Guest,
      accessExpiresAt: soon,
    });
    const [other] = await db
      .insert(cohorts)
      .values({ name: 'C3', code: 'C3', status: CohortStatus.Active })
      .returning();
    await db.insert(cohortMembers).values({
      cohortId: other.id,
      userId: invitee.id,
      role: CohortRole.Guest,
      accessExpiresAt: later,
    });

    const grant = await members.resolveActiveAccess(invitee.id);
    expect(grant?.endsAt?.toISOString()).toBe(later.toISOString());
  });

  // The other half: an active student is a standing decision, and an invite
  // sent before it must not quietly rewrite their role.
  it('still refuses to overwrite an active student', async () => {
    await db.insert(cohortMembers).values({
      cohortId: fixtures.cohortId,
      userId: invitee.id,
      cohortTrackId: fixtures.cohortTrackId,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      leftAt: null,
    });
    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
    });

    await expect(
      service.decide(invite.id, InviteDecision.Accept, invitee),
    ).rejects.toBeInstanceOf(InviteConflictException);
  });

  /**
   * Reviving a membership must not carry the last one's ending with it. The
   * schema refuses the state outright; this covers the write that would
   * otherwise produce it.
   */
  it('clears a dismissal when the membership is revived', async () => {
    await db.insert(cohortMembers).values({
      cohortId: fixtures.cohortId,
      userId: invitee.id,
      cohortTrackId: fixtures.cohortTrackId,
      role: CohortRole.Student,
      status: StudentStatus.Dismissed,
      dismissalReason: 'plagiarism',
      leftAt: new Date(),
    });

    const invite = await makeInvite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
    });
    await service.decide(invite.id, InviteDecision.Accept, invitee);

    const [row] = await membershipOf(invitee.id);
    expect(row.role).toBe(CohortRole.Professor);
    expect(row.dismissalReason).toBeNull();
  });

  describe('audit log', () => {
    const entries = () => db.select().from(auditLog);

    /**
     * The revive clears the dismissal reason from cohort_members, so the
     * audit entry is now the only record of why somebody once left.
     */
    it('keeps the row a revive replaced, dismissal reason included', async () => {
      const leftAt = new Date('2026-06-01T00:00:00.000Z');
      await db.insert(cohortMembers).values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Student,
        status: StudentStatus.Dismissed,
        dismissalReason: 'plagiarism',
        leftAt,
      });
      const invite = await makeInvite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
      });

      await service.decide(
        invite.id,
        InviteDecision.Accept,
        invitee,
        new Date(),
        'corr-revive',
      );

      const [membership] = await membershipOf(invitee.id);
      expect(await entries()).toEqual([
        expect.objectContaining({
          actorUserId: invitee.id,
          action: AuditAction.MembershipRevived,
          subjectType: AuditSubjectType.CohortMember,
          subjectId: membership.id,
          correlationId: 'corr-revive',
          details: {
            inviteId: invite.id,
            invitedBy: inviter.id,
            previous: expect.objectContaining({
              role: CohortRole.Student,
              status: StudentStatus.Dismissed,
              dismissalReason: 'plagiarism',
              leftAt: leftAt.toISOString(),
            }),
          },
        }),
      ]);
    });

    it('writes nothing for a first enrolment', async () => {
      const invite = await makeInvite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
      });

      await service.decide(invite.id, InviteDecision.Accept, invitee);

      expect(await entries()).toEqual([]);
    });

    it('writes nothing when the accept is refused', async () => {
      await db.insert(cohortMembers).values({
        cohortId: fixtures.cohortId,
        userId: invitee.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      });
      const invite = await makeInvite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
      });

      await expect(
        service.decide(invite.id, InviteDecision.Accept, invitee),
      ).rejects.toBeInstanceOf(InviteConflictException);

      expect(await entries()).toEqual([]);
    });

    it('records an admin grant, with who invited them', async () => {
      const invite = await makeInvite({ systemRole: SystemRole.Admin });

      await service.decide(
        invite.id,
        InviteDecision.Accept,
        invitee as never,
        new Date(),
        'corr-admin',
      );

      expect(await entries()).toEqual([
        expect.objectContaining({
          actorUserId: invitee.id,
          action: AuditAction.SystemRoleChanged,
          subjectType: AuditSubjectType.User,
          subjectId: invitee.id,
          correlationId: 'corr-admin',
          details: {
            from: SystemRole.User,
            to: SystemRole.Admin,
            inviteId: invite.id,
            invitedBy: inviter.id,
          },
        }),
      ]);
    });

    it('records an invite alongside the row it describes', async () => {
      const res = await service.create(
        {
          email: 'student@campus.local',
          cohortId: fixtures.cohortId,
          cohortRole: CohortRole.Student,
          cohortTrackId: fixtures.cohortTrackId,
        },
        inviter,
        'corr-invite',
      );

      expect(await entries()).toEqual([
        expect.objectContaining({
          actorUserId: inviter.id,
          action: AuditAction.InviteCreated,
          subjectType: AuditSubjectType.Invite,
          subjectId: res.id,
          correlationId: 'corr-invite',
          details: expect.objectContaining({
            cohortId: fixtures.cohortId,
            cohortRole: CohortRole.Student,
            cohortTrackId: fixtures.cohortTrackId,
            systemRole: SystemRole.User,
            guestAccessExpiresAt: null,
          }),
        }),
      ]);
    });

    // Postgres aborts the transaction on the unique violation, so the entry
    // could not survive it even if it had been written first.
    it('records nothing for an invite the pending slot refused', async () => {
      await makeInvite({ email: 'taken@campus.local' });

      await expect(
        service.create(
          { email: 'taken@campus.local', systemRole: SystemRole.Admin },
          inviter,
        ),
      ).rejects.toBeInstanceOf(InviteConflictException);

      expect(await entries()).toEqual([]);
    });

    it('records nothing when the account is already an admin', async () => {
      await db
        .update(users)
        .set({ systemRole: SystemRole.Admin })
        .where(eqUser(invitee.id));
      const invite = await makeInvite({ systemRole: SystemRole.Admin });

      await service.decide(invite.id, InviteDecision.Accept, invitee as never);

      expect(await entries()).toEqual([]);
    });
  });
});

/**
 * Admin surface: cancelling an offer and seeing the ones still out.
 *
 * Separate fixtures from the decide() block above so revoking a pending invite
 * cannot be confused with settling one — the two write the same row from
 * opposite directions.
 */
describe('InvitesService admin revoke and list', () => {
  let admin: AuthenticatedUser;
  let cohortId: string;
  let cohortTrackId: string;

  beforeEach(async () => {
    await db.execute(
      sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
    );

    const [adminRow] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    admin = {
      id: adminRow.id,
      email: adminRow.email,
      systemRole: SystemRole.Admin,
    };

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

  let sequence = 0;
  const makeInvite = async (
    overrides: Partial<typeof invites.$inferInsert> = {},
  ) => {
    sequence += 1;
    const [row] = await db
      .insert(invites)
      .values({
        email: `person${sequence}@campus.local`,
        cohortId,
        cohortRole: CohortRole.Student,
        cohortTrackId,
        systemRole: SystemRole.User,
        tokenHash: hashInviteToken(generateInviteToken()),
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: admin.id,
        createdAt: new Date(Date.UTC(2026, 0, 1) + sequence * 60_000),
        ...overrides,
      })
      .returning();
    return row;
  };

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(invites).where(eq(invites.id, id));
    return row;
  };

  describe('revoke', () => {
    it('moves a pending invite to revoked, naming who and when', async () => {
      const invite = await makeInvite();
      const at = new Date('2026-03-04T10:00:00.000Z');

      const result = await service.revoke(invite.id, admin, undefined, at);

      expect(result.status).toBe(InviteStatus.Revoked);
      expect(result.revokedBy).toBe(admin.id);
      expect(result.revokedAt).toBe(at.toISOString());

      const row = await rowOf(invite.id);
      expect(row.status).toBe(InviteStatus.Revoked);
      expect(row.revokedBy).toBe(admin.id);
      expect(row.revokedAt).toEqual(at);
    });

    /**
     * Revoked, not expired: an admin pulled this one. The distinction only
     * exists in the record, so nothing in the status column can carry it — the
     * actor columns are the whole of the difference.
     */
    it('records a cancellation rather than a lapse', async () => {
      const invite = await makeInvite();

      await service.revoke(invite.id, admin);

      const row = await rowOf(invite.id);
      expect(row.status).not.toBe(InviteStatus.Expired);
      expect(row.revokedBy).not.toBeNull();
      expect(row.revokedAt).not.toBeNull();
      // A lapsed invite has no actor, so these must not be conflated.
      expect(row.acceptedAt).toBeNull();
    });

    it('refuses an already-revoked invite with INVITE_REVOKED', async () => {
      const invite = await makeInvite();
      await service.revoke(invite.id, admin);

      await expect(service.revoke(invite.id, admin)).rejects.toBeInstanceOf(
        InviteRevokedException,
      );
    });

    it('refuses an accepted invite with INVITE_ALREADY_ACCEPTED', async () => {
      const invite = await makeInvite({
        status: InviteStatus.Accepted,
        acceptedAt: new Date(),
      });

      await expect(service.revoke(invite.id, admin)).rejects.toBeInstanceOf(
        InviteAlreadyAcceptedException,
      );
      expect((await rowOf(invite.id)).status).toBe(InviteStatus.Accepted);
    });

    it('refuses a declined invite with INVITE_ALREADY_DECLINED', async () => {
      const invite = await makeInvite({ status: InviteStatus.Declined });

      await expect(service.revoke(invite.id, admin)).rejects.toBeInstanceOf(
        InviteAlreadyDeclinedException,
      );
      expect((await rowOf(invite.id)).status).toBe(InviteStatus.Declined);
    });

    /**
     * An invite that has already stopped on its own has no cancellation to
     * record. Refusing it also refuses to relabel it: the row becomes expired,
     * which is what it was, rather than revoked, which would put an actor on
     * an event nobody performed.
     */
    it('answers a lapsed invite as expired and materialises the flip', async () => {
      const invite = await makeInvite({
        expiresAt: new Date(Date.now() - 86_400_000),
      });

      await expect(service.revoke(invite.id, admin)).rejects.toBeInstanceOf(
        InviteExpiredException,
      );

      const row = await rowOf(invite.id);
      expect(row.status).toBe(InviteStatus.Expired);
      expect(row.revokedAt).toBeNull();
      expect(row.revokedBy).toBeNull();
    });

    it('404s an invite that does not exist', async () => {
      await expect(
        service.revoke('00000000-0000-4000-8000-000000000000', admin),
      ).rejects.toBeInstanceOf(InviteNotFoundException);
    });

    /**
     * The whole point of the route. invites_email_pending_unique covers only
     * pending rows, so revoking is what frees the slot create() refuses to
     * take twice.
     */
    it('frees the address so the same person can be invited again', async () => {
      const invite = await makeInvite({ email: 'again@campus.local' });

      await expect(
        service.create(
          {
            email: 'again@campus.local',
            cohortId,
            cohortRole: CohortRole.Professor,
          },
          admin,
        ),
      ).rejects.toBeInstanceOf(InviteConflictException);

      await service.revoke(invite.id, admin);

      const reissued = await service.create(
        {
          email: 'again@campus.local',
          cohortId,
          cohortRole: CohortRole.Professor,
        },
        admin,
      );
      expect(reissued.id).not.toBe(invite.id);
      expect(reissued.status).toBe(InviteStatus.Pending);
    });
  });

  describe('list', () => {
    it('returns newest first with pagination totals', async () => {
      await makeInvite({ email: 'a@campus.local' });
      await makeInvite({ email: 'b@campus.local' });
      await makeInvite({ email: 'c@campus.local' });

      const page = await service.list({ page: 1, perPage: 2 });

      expect(page.items.map((i) => i.email)).toEqual([
        'c@campus.local',
        'b@campus.local',
      ]);
      expect(page.meta).toEqual({
        page: 1,
        perPage: 2,
        total: 3,
        totalPages: 2,
      });
    });

    it('walks pages without repeating or dropping a row', async () => {
      await makeInvite({ email: 'a@campus.local' });
      await makeInvite({ email: 'b@campus.local' });
      await makeInvite({ email: 'c@campus.local' });

      const first = await service.list({ page: 1, perPage: 2 });
      const second = await service.list({ page: 2, perPage: 2 });

      expect(first.items.map((i) => i.id)).not.toEqual(
        expect.arrayContaining(second.items.map((i) => i.id)),
      );
      expect([...first.items, ...second.items]).toHaveLength(3);
    });

    it('filters by status', async () => {
      const pending = await makeInvite({ email: 'open@campus.local' });
      const revoked = await makeInvite({ email: 'gone@campus.local' });
      await service.revoke(revoked.id, admin);

      const onlyPending = await service.list({
        page: 1,
        perPage: 20,
        status: InviteStatus.Pending,
      });
      expect(onlyPending.items.map((i) => i.id)).toEqual([pending.id]);
      expect(onlyPending.meta.total).toBe(1);

      const onlyRevoked = await service.list({
        page: 1,
        perPage: 20,
        status: InviteStatus.Revoked,
      });
      expect(onlyRevoked.items.map((i) => i.id)).toEqual([revoked.id]);
    });

    /**
     * The one that justifies not reusing InviteResponseDto. That one carries
     * the raw token because it is shown exactly once at creation; a list would
     * hand out every unredeemed token in the system to any admin who asked for
     * page 1.
     */
    it('never carries a token, a hash or a shareable link', async () => {
      await makeInvite({ email: 'a@campus.local' });

      const page = await service.list({ page: 1, perPage: 20 });
      const [item] = page.items;
      const row = await rowOf(item.id);

      const serialised = JSON.stringify(page);
      expect(serialised).not.toContain('token');
      expect(serialised).not.toContain('tokenHash');
      expect(serialised).not.toContain('inviteLink');
      expect(serialised).not.toContain(row.tokenHash);
      expect(Object.keys(item).sort()).toEqual([
        'cohortId',
        'cohortRole',
        'createdAt',
        'email',
        'expiresAt',
        'flagMessage',
        'flaggedAt',
        'id',
        'invitedBy',
        'revokedAt',
        'revokedBy',
        'status',
        'systemRole',
      ]);
    });

    /**
     * A revoked invite is invisible to sign-in, so this list is the only place
     * the question "who killed this offer" can be answered.
     */
    it('keeps revoked invites visible with their actor', async () => {
      const invite = await makeInvite({ email: 'gone@campus.local' });
      await service.revoke(
        invite.id,
        admin,
        undefined,
        new Date('2026-03-04T10:00:00Z'),
      );

      const page = await service.list({ page: 1, perPage: 20 });
      const found = page.items.find((i) => i.id === invite.id);

      expect(found).toBeDefined();
      expect(found?.status).toBe(InviteStatus.Revoked);
      expect(found?.revokedBy).toBe(admin.id);
      expect(found?.revokedAt).toBe('2026-03-04T10:00:00.000Z');
    });

    it('leaves revokedBy and revokedAt null for invites nobody cancelled', async () => {
      const invite = await makeInvite({
        status: InviteStatus.Accepted,
        acceptedAt: new Date(),
      });

      const page = await service.list({ page: 1, perPage: 20 });
      const found = page.items.find((i) => i.id === invite.id);

      expect(found?.status).toBe(InviteStatus.Accepted);
      expect(found?.revokedBy).toBeNull();
      expect(found?.revokedAt).toBeNull();
    });

    /**
     * Migration 0002 revoked every cohort-less pending invite by UPDATE alone,
     * so those rows say `revoked` with nobody to blame. They predate the
     * attribution columns and must be listed honestly rather than guessed at:
     * the columns say "nobody recorded this", and inventing an actor would be
     * a false record of who cancelled an offer.
     */
    it('lists a revoked invite that predates the attribution columns', async () => {
      const invite = await makeInvite({
        cohortId: null,
        cohortRole: null,
        // invites_scoped_fields_require_cohort: the scoped columns have to go
        // with the cohort, and a cohort-less invite must be an admin one.
        cohortTrackId: null,
        systemRole: SystemRole.Admin,
        status: InviteStatus.Revoked,
      });
      expect((await rowOf(invite.id)).revokedAt).toBeNull();

      const page = await service.list({
        page: 1,
        perPage: 20,
        status: InviteStatus.Revoked,
      });
      const found = page.items.find((i) => i.id === invite.id);

      expect(found).toBeDefined();
      expect(found?.status).toBe(InviteStatus.Revoked);
      expect(found?.revokedBy).toBeNull();
      expect(found?.revokedAt).toBeNull();
    });

    it('does not backfill an actor when refusing to revoke a revoked row', async () => {
      const invite = await makeInvite({ status: InviteStatus.Revoked });

      await expect(service.revoke(invite.id, admin)).rejects.toBeInstanceOf(
        InviteRevokedException,
      );

      // The revocation already happened; stamping this admin onto it now would
      // claim they did it.
      const row = await rowOf(invite.id);
      expect(row.revokedBy).toBeNull();
      expect(row.revokedAt).toBeNull();
    });

    /**
     * The flip to expired is lazy, so a lapsed row can still say pending. The
     * filter reads it the way isInviteLive does: `pending` is what can still
     * be revoked, and the lapsed row turns up under `expired`, saying so.
     */
    it('files a lapsed invite under expired, never pending', async () => {
      const live = await makeInvite();
      const lapsed = await makeInvite({
        expiresAt: new Date(Date.now() - 1_000),
      });
      const flipped = await makeInvite({
        status: InviteStatus.Expired,
        expiresAt: new Date(Date.now() - 86_400_000),
      });

      const pending = await service.list({
        page: 1,
        perPage: 20,
        status: InviteStatus.Pending,
      });
      expect(pending.items.map((i) => i.id)).toEqual([live.id]);
      expect(pending.meta.total).toBe(1);

      const expired = await service.list({
        page: 1,
        perPage: 20,
        status: InviteStatus.Expired,
      });
      expect(expired.items.map((i) => i.id).sort()).toEqual(
        [lapsed.id, flipped.id].sort(),
      );
      expect(expired.meta.total).toBe(2);
      expect(
        expired.items.every((i) => i.status === InviteStatus.Expired),
      ).toBe(true);

      const all = await service.list({ page: 1, perPage: 20 });
      expect(all.items.find((i) => i.id === lapsed.id)?.status).toBe(
        InviteStatus.Expired,
      );
    });
  });

  describe('invites_revoked_fields', () => {
    it('refuses an actor on an invite that is not revoked', async () => {
      const invite = await makeInvite();

      await expect(
        db
          .update(invites)
          .set({ revokedAt: new Date(), revokedBy: admin.id })
          .where(eq(invites.id, invite.id)),
      ).rejects.toThrow();
    });

    it('refuses a revoked invite naming who but not when', async () => {
      await expect(
        makeInvite({ status: InviteStatus.Revoked, revokedBy: admin.id }),
      ).rejects.toThrow();
    });
  });

  describe('flag', () => {
    const MESSAGE = 'I applied for Product Design, not Software Engineering.';

    const inviteeOf = async (invite: {
      email: string;
    }): Promise<AuthenticatedUser> => {
      const [row] = await db
        .insert(users)
        .values({ email: invite.email })
        .returning();
      return { id: row.id, email: row.email, systemRole: SystemRole.User };
    };

    it('records the message and the moment, and leaves the invite pending', async () => {
      const invite = await makeInvite();
      const invitee = await inviteeOf(invite);
      const at = new Date('2026-03-04T10:00:00.000Z');

      const flagged = await service.flag(
        invite.id,
        MESSAGE,
        invitee,
        'corr-1',
        at,
      );

      expect(flagged.flaggedAt).toEqual(at);
      const row = await rowOf(invite.id);
      expect(row.status).toBe(InviteStatus.Pending);
      expect(row.flagMessage).toBe(MESSAGE);
      expect(row.flaggedAt).toEqual(at);
    });

    it('can still be accepted afterwards', async () => {
      const invite = await makeInvite();
      const invitee = await inviteeOf(invite);
      await service.flag(invite.id, MESSAGE, invitee);

      const outcome = await service.decide(
        invite.id,
        InviteDecision.Accept,
        invitee,
      );

      expect(outcome.kind).toBe('accepted');
      const row = await rowOf(invite.id);
      expect(row.status).toBe(InviteStatus.Accepted);
      // The flag outlives the answer: it is the record of what was said.
      expect(row.flagMessage).toBe(MESSAGE);
    });

    it('writes an audit entry naming the invitee, without the message', async () => {
      const invite = await makeInvite();
      const invitee = await inviteeOf(invite);

      await service.flag(invite.id, MESSAGE, invitee, 'corr-1');

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.InviteFlagged));
      expect(entry).toMatchObject({
        actorUserId: invitee.id,
        subjectType: AuditSubjectType.Invite,
        subjectId: invite.id,
        correlationId: 'corr-1',
      });
      expect(JSON.stringify(entry.details)).not.toContain(MESSAGE);
    });

    it('refuses a second flag and keeps what the first one said', async () => {
      const invite = await makeInvite();
      const invitee = await inviteeOf(invite);
      await service.flag(invite.id, MESSAGE, invitee);

      await expect(
        service.flag(invite.id, 'something else', invitee),
      ).rejects.toBeInstanceOf(InviteConflictException);
      expect((await rowOf(invite.id)).flagMessage).toBe(MESSAGE);
    });

    it.each([
      [InviteStatus.Accepted, InviteAlreadyAcceptedException],
      [InviteStatus.Declined, InviteAlreadyDeclinedException],
      [InviteStatus.Revoked, InviteRevokedException],
    ] as const)(
      'refuses a %s invite with its own code',
      async (status, exception) => {
        const invite = await makeInvite({ status });
        const invitee = await inviteeOf(invite);

        await expect(
          service.flag(invite.id, MESSAGE, invitee),
        ).rejects.toBeInstanceOf(exception);
        expect((await rowOf(invite.id)).flaggedAt).toBeNull();
      },
    );

    it('answers a lapsed invite as expired and materialises the flip', async () => {
      const invite = await makeInvite({
        expiresAt: new Date(Date.now() - 1000),
      });
      const invitee = await inviteeOf(invite);

      await expect(
        service.flag(invite.id, MESSAGE, invitee),
      ).rejects.toBeInstanceOf(InviteExpiredException);
      const row = await rowOf(invite.id);
      expect(row.status).toBe(InviteStatus.Expired);
      expect(row.flaggedAt).toBeNull();
    });

    it('404s an invite that does not exist', async () => {
      await expect(
        service.flag('99999999-9999-4999-8999-999999999999', MESSAGE, admin),
      ).rejects.toBeInstanceOf(InviteNotFoundException);
    });

    it('leaves nothing behind when the invite is somebody else’s', async () => {
      const invite = await makeInvite();

      // The admin is signed in, but the invite is not addressed to them.
      await expect(
        service.flag(invite.id, MESSAGE, admin),
      ).rejects.toBeInstanceOf(InviteInternalException);
      expect((await rowOf(invite.id)).flaggedAt).toBeNull();
      expect(
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, AuditAction.InviteFlagged)),
      ).toHaveLength(0);
    });

    it('refuses a message with no moment', async () => {
      const invite = await makeInvite();

      await expect(
        db
          .update(invites)
          .set({ flagMessage: MESSAGE })
          .where(eq(invites.id, invite.id)),
      ).rejects.toThrow();
    });

    it('lists flagged invites on their own, with what was said', async () => {
      const flagged = await makeInvite();
      const quiet = await makeInvite();
      await service.flag(flagged.id, MESSAGE, await inviteeOf(flagged));

      const only = await service.list({ page: 1, perPage: 20, flagged: true });
      const rest = await service.list({ page: 1, perPage: 20, flagged: false });

      expect(only.items.map((item) => item.id)).toEqual([flagged.id]);
      expect(only.items[0].flagMessage).toBe(MESSAGE);
      expect(only.items[0].flaggedAt).toEqual(expect.any(String));
      expect(rest.items.map((item) => item.id)).toEqual([quiet.id]);
      expect(rest.items[0].flaggedAt).toBeNull();
    });

    it('reads back what the email to the inviter needs', async () => {
      const invite = await makeInvite();
      await service.flag(invite.id, MESSAGE, await inviteeOf(invite));

      await expect(service.getFlagNotice(invite.id)).resolves.toMatchObject({
        inviterEmail: admin.email,
        inviteeEmail: invite.email,
        cohortName: 'Cohort 1',
        trackName: 'Software Engineering',
        cohortRole: CohortRole.Student,
        message: MESSAGE,
      });
    });

    it('has no notice for an invite nobody flagged', async () => {
      const invite = await makeInvite();

      await expect(service.getFlagNotice(invite.id)).resolves.toBeNull();
    });
  });

  describe('currentInviteFor', () => {
    it('keeps a live invite', async () => {
      const own = await makeInvite();

      await expect(service.currentInviteFor(own.id, own.email)).resolves.toBe(
        own.id,
      );
    });

    it('follows a revoked invite to the one that replaced it', async () => {
      const own = await makeInvite({ email: 'again@campus.local' });
      await service.revoke(own.id, admin);
      const replacement = await makeInvite({ email: 'again@campus.local' });

      await expect(service.currentInviteFor(own.id, own.email)).resolves.toBe(
        replacement.id,
      );
    });

    it('stays on a dead invite with nothing to replace it', async () => {
      const own = await makeInvite();
      await service.revoke(own.id, admin);

      await expect(service.currentInviteFor(own.id, own.email)).resolves.toBe(
        own.id,
      );
    });

    it('never follows to an invite addressed to somebody else', async () => {
      const own = await makeInvite({ email: 'mine@campus.local' });
      await service.revoke(own.id, admin);
      await makeInvite({ email: 'theirs@campus.local' });

      await expect(service.currentInviteFor(own.id, own.email)).resolves.toBe(
        own.id,
      );
    });
  });
});
