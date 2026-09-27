import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import {
  CohortRole,
  CohortStatus,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';
import {
  InviteConflictException,
  InviteForbiddenException,
  InviteInternalException,
  InviteInvalidArgumentException,
  InviteNotFoundException,
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
  schema: { users, tracks, cohorts, cohortTracks, invites },
});

const config = {
  APP_PUBLIC_URL: 'http://localhost:3000',
  INVITE_TTL_DAYS: 7,
} as never;

const service = new InvitesService(db as never, config);
const inviter = { id: '', email: 'admin@campus.local', systemRole: 'admin' };

let fixtures: { cohortId: string; cohortTrackId: string };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
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

  it('accepts a guest invite { email } end to end', async () => {
    const res = await service.create({ email: 'guest@campus.local' }, inviter);
    expect(res.systemRole).toBe(SystemRole.User);
    expect(res.cohortId).toBeNull();
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
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const raw = await db
      .insert(invites)
      .values({
        email: 'raw@campus.local',
        tokenHash: 'hash-two',
        invitedBy: inviter.id,
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
      service.create({ email: 'x@campus.local', cohortId: fixtures.cohortId }, inviter),
    ).rejects.toBeInstanceOf(InviteInvalidArgumentException);
  });
});

/**
 * getOnboardingInvite is the only read path that crosses from a session to
 * invite rows, so it is exercised against real Postgres rather than a mock:
 * the join shape, the nullable cohort columns for guest invites, and the
 * lazy status flip are all things a mocked db can only agree with.
 */
describe('getOnboardingInvite', () => {
  const seedInvitee = async (
    email = 'invitee@campus.local',
  ): Promise<{ id: string; email: string; systemRole: string }> => {
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
    const created = await service.create({ email: invitee.email }, named);

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
      { email: invitee.email, cohortId: fixtures.cohortId, cohortRole: CohortRole.Student, cohortTrackId: fixtures.cohortTrackId },
      inviter,
    );

    const wire = JSON.stringify(
      await service.getOnboardingInvite(created.id, invitee),
    );

    expect(wire).not.toContain(created.token);
    expect(wire).not.toContain('inviteLink');
    expect(wire).not.toContain('tokenHash');
  });

  it('returns nulls for the cohort shape of a guest invite', async () => {
    const invitee = await seedInvitee('guest-invitee@campus.local');
    const created = await service.create({ email: invitee.email }, inviter);

    const res = await service.getOnboardingInvite(created.id, invitee);

    expect(res.cohort).toBeNull();
    expect(res.cohortTrack).toBeNull();
    expect(res.track).toBeNull();
    expect(res.cohortRole).toBeNull();
    expect(res.systemRole).toBe(SystemRole.User);
  });

  it('404s on an id that matches nothing', async () => {
    const invitee = await seedInvitee();
    await expect(
      service.getOnboardingInvite('00000000-0000-4000-8000-000000000000', invitee),
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
    const created = await service.create({ email: owner.email }, inviter);

    await expect(
      service.getOnboardingInvite(created.id, impostor),
    ).rejects.toBeInstanceOf(InviteInternalException);
  });

  it('403s a lapsed invite and materialises the status flip', async () => {
    const invitee = await seedInvitee();
    const created = await service.create({ email: invitee.email }, inviter);
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(sql`${invites.id} = ${created.id}`);

    await expect(
      service.getOnboardingInvite(created.id, invitee),
    ).rejects.toBeInstanceOf(InviteForbiddenException);

    const [row] = await db
      .select({ status: invites.status })
      .from(invites)
      .where(sql`${invites.id} = ${created.id}`);
    expect(row.status).toBe(InviteStatus.Expired);
  });

  it('409s a resolved invite and leaves its status alone', async () => {
    const invitee = await seedInvitee();
    const created = await service.create({ email: invitee.email }, inviter);
    await db
      .update(invites)
      .set({ status: InviteStatus.Declined })
      .where(sql`${invites.id} = ${created.id}`);

    await expect(
      service.getOnboardingInvite(created.id, invitee),
    ).rejects.toBeInstanceOf(InviteConflictException);

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
  describe('expireLazily guards', () => {
    const expireLazily = (id: string, now = new Date()) =>
      (service as unknown as {
        expireLazily(id: string, now?: Date): Promise<void>;
      }).expireLazily(id, now);

    const statusOf = async (id: string) => {
      const [row] = await db
        .select({ status: invites.status })
        .from(invites)
        .where(sql`${invites.id} = ${id}`);
      return row.status;
    };

    it('flips a still-pending lapsed invite', async () => {
      const invitee = await seedInvitee('flip@campus.local');
      const created = await service.create({ email: invitee.email }, inviter);
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
      const created = await service.create({ email: invitee.email }, inviter);
      await db
        .update(invites)
        .set({ status: InviteStatus.Accepted, expiresAt: new Date(Date.now() - 1_000) })
        .where(sql`${invites.id} = ${created.id}`);

      await expireLazily(created.id);

      expect(await statusOf(created.id)).toBe(InviteStatus.Accepted);
    });

    /** And the lapsed-not-yet-expired half, so a live offer is never buried. */
    it('leaves a still-live invite alone', async () => {
      const invitee = await seedInvitee('live@campus.local');
      const created = await service.create({ email: invitee.email }, inviter);

      await expireLazily(created.id);

      expect(await statusOf(created.id)).toBe(InviteStatus.Pending);
    });
  });
});
