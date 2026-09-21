import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import {
  CohortRole,
  CohortStatus,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../../modules/cohorts/schema.js';
import { InviteStatus, invites } from '../../modules/invites/schema.js';
import { tracks } from '../../modules/tracks/schema.js';
import { SystemRole, users } from '../../modules/users/schema.js';

/**
 * The constraints in the migration are the product here — a check that only
 * exists in a drizzle schema file protects nothing. These run against a real
 * PostgreSQL engine (PGlite, in-process) with the committed migrations
 * applied, so a regenerated migration that drops a rule fails the build.
 */
const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers, invites },
});

/** Asserts the write failed on one specific named constraint. */
async function expectViolation(
  write: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await write;
  } catch (caught) {
    error = caught;
  }

  const detail =
    error instanceof Error
      ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}`
      : String(error);

  expect(
    error,
    `expected a violation of ${constraint}, but the write succeeded`,
  ).toBeDefined();
  expect(detail).toContain(constraint);
}

let fixtures: {
  adminId: string;
  trackId: string;
  cohortId: string;
  otherCohortId: string;
  cohortTrackId: string;
  otherCohortTrackId: string;
};

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
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Software Engineering', code: 'SE' })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1', status: CohortStatus.Active })
    .returning();
  const [otherCohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 2', code: 'C2' })
    .returning();
  const [cohortTrack] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort.id, trackId: track.id })
    .returning();
  const [otherCohortTrack] = await db
    .insert(cohortTracks)
    .values({ cohortId: otherCohort.id, trackId: track.id })
    .returning();

  fixtures = {
    adminId: admin.id,
    trackId: track.id,
    cohortId: cohort.id,
    otherCohortId: otherCohort.id,
    cohortTrackId: cohortTrack.id,
    otherCohortTrackId: otherCohortTrack.id,
  };
});

function invite(overrides: Partial<typeof invites.$inferInsert> = {}) {
  return db.insert(invites).values({
    email: 'invitee@campus.local',
    tokenHash: `hash-${Math.random().toString(36).slice(2)}`,
    invitedBy: fixtures.adminId,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  });
}

function member(overrides: Partial<typeof cohortMembers.$inferInsert> = {}) {
  return db.insert(cohortMembers).values({
    cohortId: fixtures.cohortId,
    userId: fixtures.adminId,
    role: CohortRole.Professor,
    ...overrides,
  });
}

describe('users', () => {
  it('stores one account per address, case-insensitively', async () => {
    await expectViolation(
      db.insert(users).values({ email: 'admin@campus.local' }),
      'users_email_unique',
    );
    await expectViolation(
      db.insert(users).values({ email: 'Admin@Campus.Local' }),
      'users_email_lowercase',
    );
  });

  it('ties a provider identity to one user, but leaves seeded users free', async () => {
    await db.insert(users).values({
      email: 'a@campus.local',
      provider: 'google',
      providerId: 'g-1',
    });

    await expectViolation(
      db.insert(users).values({
        email: 'b@campus.local',
        provider: 'google',
        providerId: 'g-1',
      }),
      'users_provider_provider_id_unique',
    );

    // Seeded users have no provider_id until their first login, so the index
    // must not treat two of them as the same identity.
    await db.insert(users).values({ email: 'c@campus.local' });
    await db.insert(users).values({ email: 'd@campus.local' });
  });
});

describe('tracks and cohorts', () => {
  it('keeps codes uppercase and unique', async () => {
    await expectViolation(
      db.insert(tracks).values({ name: 'dup', code: 'SE' }),
      'tracks_code_unique',
    );
    await expectViolation(
      db.insert(tracks).values({ name: 'lower', code: 'se' }),
      'tracks_code_uppercase',
    );
    await expectViolation(
      db.insert(cohorts).values({ name: 'dup', code: 'C1' }),
      'cohorts_code_unique',
    );
    await expectViolation(
      db.insert(cohorts).values({ name: 'lower', code: 'c1' }),
      'cohorts_code_uppercase',
    );
  });

  it('runs a track at most once per cohort', async () => {
    await expectViolation(
      db
        .insert(cohortTracks)
        .values({ cohortId: fixtures.cohortId, trackId: fixtures.trackId }),
      'cohort_tracks_track_id_cohort_id_key',
    );
  });

  /**
   * The other unique on cohort_tracks, (id, cohort_id), cannot be violated
   * directly — id is already the primary key. It exists only so the composite
   * FKs on invites and cohort_members have a target, and those are covered by
   * the "track from another cohort" cases below.
   */
  it('refuses rows pointing at a cohort or track that does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';

    await expectViolation(
      db
        .insert(cohortTracks)
        .values({ cohortId: missing, trackId: fixtures.trackId }),
      'cohort_tracks_cohort_id_cohorts_id_fk',
    );
    await expectViolation(
      db
        .insert(cohortTracks)
        .values({ cohortId: fixtures.cohortId, trackId: missing }),
      'cohort_tracks_track_id_tracks_id_fk',
    );
    await expectViolation(
      member({ cohortId: missing }),
      'cohort_members_cohort_id_cohorts_id_fk',
    );
    await expectViolation(
      member({ userId: missing }),
      'cohort_members_user_id_users_id_fk',
    );
    await expectViolation(
      invite({ cohortId: missing, cohortRole: CohortRole.Professor }),
      'invites_cohort_id_cohorts_id_fk',
    );
  });
});

describe('invites', () => {
  it('accepts an admin-wide invite', async () => {
    await invite({ systemRole: SystemRole.Admin });
  });

  it('accepts a student invite carrying its cohort, track and role', async () => {
    await invite({
      cohortId: fixtures.cohortId,
      cohortTrackId: fixtures.cohortTrackId,
      cohortRole: CohortRole.Student,
    });
  });

  it('accepts a professor invite with no track', async () => {
    await invite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
    });
  });

  it('requires a track for student invites', async () => {
    await expectViolation(
      invite({ cohortId: fixtures.cohortId, cohortRole: CohortRole.Student }),
      'invites_student_requires_track',
    );
  });

  it('requires the track to belong to the invite cohort', async () => {
    await expectViolation(
      invite({
        cohortId: fixtures.cohortId,
        cohortTrackId: fixtures.otherCohortTrackId,
        cohortRole: CohortRole.Student,
      }),
      'invites_cohort_track_fk',
    );
  });

  it('allows one pending invite per address, and a re-invite once resolved', async () => {
    await invite({ email: 'dup@campus.local' });

    await expectViolation(
      invite({ email: 'dup@campus.local' }),
      'invites_email_pending_unique',
    );

    await db
      .update(invites)
      .set({ status: InviteStatus.Declined })
      .where(sql`email = 'dup@campus.local'`);
    await invite({ email: 'dup@campus.local' });
  });

  it('frees the pending slot when an admin revokes an invite', async () => {
    await invite({ email: 'revoked@campus.local' });

    await db
      .update(invites)
      .set({ status: InviteStatus.Revoked })
      .where(sql`email = 'revoked@campus.local'`);

    await invite({ email: 'revoked@campus.local' });
  });

  it('keeps token hashes unique', async () => {
    await invite({ tokenHash: 'fixed-hash' });
    await expectViolation(
      invite({ email: 'other@campus.local', tokenHash: 'fixed-hash' }),
      'invites_token_hash_unique',
    );
  });

  it('stores addresses lowercase', async () => {
    await expectViolation(
      invite({ email: 'Mixed@Campus.local' }),
      'invites_email_lowercase',
    );
  });

  it('requires a real inviter', async () => {
    await expectViolation(
      invite({ invitedBy: '00000000-0000-0000-0000-000000000000' }),
      'invites_invited_by_users_id_fk',
    );
  });

  // cohort_id and cohort_role travel together: neither for a guest, both for
  // a cohort invite.
  it('accepts a guest invite, which carries no cohort and no role', async () => {
    await invite({ systemRole: SystemRole.User });
  });

  it('requires a cohort role on a cohort-scoped invite', async () => {
    await expectViolation(
      invite({ cohortId: fixtures.cohortId }),
      'invites_cohort_pairing',
    );
  });

  it('refuses a cohort role with no cohort', async () => {
    await expectViolation(
      invite({ cohortRole: CohortRole.Professor }),
      'invites_cohort_pairing',
    );
  });

  it('refuses either scoped field with no cohort', async () => {
    await expectViolation(
      invite({ cohortTrackId: fixtures.cohortTrackId }),
      'invites_scoped_fields_require_cohort',
    );
    await expectViolation(
      invite({ mentorshipGroupId: '00000000-0000-0000-0000-000000000001' }),
      'invites_scoped_fields_require_cohort',
    );
  });

  // system_role is independent of cohort scoping, so an admin who is also a
  // professor on a cohort is expressible.
  it('accepts an admin invite that is also cohort-scoped', async () => {
    await invite({
      systemRole: SystemRole.Admin,
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Professor,
    });
  });
});

describe('cohort members', () => {
  it('requires a track for students', async () => {
    await expectViolation(
      member({ role: CohortRole.Student, status: StudentStatus.Active }),
      'cohort_members_student_requires_track',
    );
  });

  it('keeps the student status off professors and mentors', async () => {
    await expectViolation(
      member({ role: CohortRole.Mentor, status: StudentStatus.Active }),
      'cohort_members_student_status',
    );

    // A student with no status yet is allowed, per the spec's check.
    await member({
      role: CohortRole.Student,
      cohortTrackId: fixtures.cohortTrackId,
    });
  });

  it('requires the track to belong to the membership cohort', async () => {
    await expectViolation(
      member({
        cohortId: fixtures.cohortId,
        cohortTrackId: fixtures.otherCohortTrackId,
      }),
      'cohort_members_cohort_track_fk',
    );
  });

  it('allows one membership row per person per cohort, ever', async () => {
    await member();
    await expectViolation(member(), 'cohort_members_unique');

    // Returning after leaving reuses the row rather than adding a second.
    await db
      .update(cohortMembers)
      .set({ leftAt: new Date() })
      .where(sql`user_id = ${fixtures.adminId}`);
    await expectViolation(member(), 'cohort_members_unique');
  });

  it('allows the same person in a second cohort', async () => {
    await member();
    await member({ cohortId: fixtures.otherCohortId });
  });
});
