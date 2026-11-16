import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { CommentTargetType, comments } from '../../modules/comments/schema.js';
import {
  CohortRole,
  CohortStatus,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../../modules/cohorts/schema.js';
import { InviteStatus, invites } from '../../modules/invites/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../../modules/mentorship-groups/schema.js';
import { NoticeScope, notices } from '../../modules/notices/schema.js';
import { notifications } from '../../modules/notifications/schema.js';
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
  schema: {
    users,
    tracks,
    cohorts,
    cohortTracks,
    cohortMembers,
    invites,
    notices,
    notifications,
    comments,
  },
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
    sql`truncate comments, mentorship_group_students, mentorship_groups, notices, notifications, space_memberships, spaces, maps, invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
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
    // invites_cohortless_is_admin: with no cohort, an invite can only be an
    // admin one — so that is what a bare fixture means here.
    systemRole: overrides.cohortId == null ? SystemRole.Admin : SystemRole.User,
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

  it('refuses a cohort that ends before it starts', async () => {
    await expectViolation(
      db.insert(cohorts).values({
        name: 'Backwards',
        code: 'BACK',
        startDate: '2026-03-01',
        endDate: '2026-02-01',
      }),
      'cohorts_dates_in_order',
    );
  });

  it('accepts a cohort with one date, the same date twice, or neither', async () => {
    await db.insert(cohorts).values([
      { name: 'Open', code: 'OPEN', startDate: '2026-03-01' },
      { name: 'Ends', code: 'ENDS', endDate: '2026-03-01' },
      {
        name: 'Day',
        code: 'DAY',
        startDate: '2026-03-01',
        endDate: '2026-03-01',
      },
      { name: 'Undated', code: 'UNDATED' },
    ]);
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
  it('refuses an invite with no cohort that grants no admin role', async () => {
    await expectViolation(
      invite({ systemRole: SystemRole.User }),
      'invites_cohortless_is_admin',
    );
  });

  // Only the seed makes a super admin. The route refuses to invite one;
  // this is what refuses a write that never went through the route.
  it('refuses an invite that offers super admin, with or without a cohort', async () => {
    await expectViolation(
      invite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Mentor,
        systemRole: SystemRole.SuperAdmin,
      }),
      'invites_system_role_grantable',
    );
    // A pending one with no cohort is refused by invites_cohortless_is_admin
    // first, so the settled shape is what shows this rule on its own.
    await expectViolation(
      invite({
        systemRole: SystemRole.SuperAdmin,
        status: InviteStatus.Revoked,
      }),
      'invites_system_role_grantable',
    );
  });

  it('accepts a guest invited to one cohort, with an end date', async () => {
    await invite({
      cohortId: fixtures.cohortId,
      cohortRole: CohortRole.Guest,
      guestAccessExpiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
  });

  it('refuses a guest whose visit never ends', async () => {
    await expectViolation(
      invite({ cohortId: fixtures.cohortId, cohortRole: CohortRole.Guest }),
      'invites_guest_has_expiry',
    );
  });

  it('refuses an end date on a role that is not a guest', async () => {
    await expectViolation(
      invite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
        guestAccessExpiresAt: new Date(Date.now() + 86_400_000),
      }),
      'invites_guest_has_expiry',
    );
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

  /**
   * A reason says why a membership ended, so it needs the end. Keyed to
   * `left_at` and not to a status: a removal sets no status, and a live row
   * left holding an old reason would read on any roster as current.
   */
  it('keeps a reason only on a membership that has ended', async () => {
    await expectViolation(
      member({ dismissalReason: 'Plagiarism.' }),
      'cohort_members_dismissal_reason',
    );

    // Any end may carry one, a removal with no status included.
    await member({
      dismissalReason: 'Left the programme.',
      leftAt: new Date(),
    });
    await member({
      cohortId: fixtures.otherCohortId,
      role: CohortRole.Student,
      cohortTrackId: fixtures.otherCohortTrackId,
      status: StudentStatus.Withdrawn,
      dismissalReason: 'Moved abroad.',
      leftAt: new Date(),
    });
  });
});

describe('mentorship groups', () => {
  let setup: {
    mentorMemberId: string;
    otherMentorMemberId: string;
    studentMemberId: string;
    otherStudentMemberId: string;
    secondMentorMemberId: string;
  };

  beforeEach(async () => {
    const [mentorUser] = await db
      .insert(users)
      .values({ email: 'mentor@campus.local' })
      .returning();
    const [studentUser] = await db
      .insert(users)
      .values({ email: 'student@campus.local' })
      .returning();
    const [otherMentorUser] = await db
      .insert(users)
      .values({ email: 'other-mentor@campus.local' })
      .returning();
    const [otherStudentUser] = await db
      .insert(users)
      .values({ email: 'other-student@campus.local' })
      .returning();
    const [secondMentorUser] = await db
      .insert(users)
      .values({ email: 'second-mentor@campus.local' })
      .returning();

    const [mentor] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: mentorUser.id,
        role: CohortRole.Mentor,
      })
      .returning();
    const [secondMentor] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: secondMentorUser.id,
        role: CohortRole.Mentor,
      })
      .returning();
    const [student] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.cohortId,
        userId: studentUser.id,
        cohortTrackId: fixtures.cohortTrackId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      })
      .returning();
    const [otherMentor] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.otherCohortId,
        userId: otherMentorUser.id,
        role: CohortRole.Mentor,
      })
      .returning();
    const [otherStudent] = await db
      .insert(cohortMembers)
      .values({
        cohortId: fixtures.otherCohortId,
        userId: otherStudentUser.id,
        cohortTrackId: fixtures.otherCohortTrackId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      })
      .returning();

    setup = {
      mentorMemberId: mentor.id,
      secondMentorMemberId: secondMentor.id,
      studentMemberId: student.id,
      otherMentorMemberId: otherMentor.id,
      otherStudentMemberId: otherStudent.id,
    };
  });

  const group = (
    overrides: Partial<typeof mentorshipGroups.$inferInsert> = {},
  ) =>
    db.insert(mentorshipGroups).values({
      cohortId: fixtures.cohortId,
      mentorMemberId: setup.mentorMemberId,
      name: 'Pod A',
      ...overrides,
    });

  it('requires the mentor to be a member of the same cohort', async () => {
    await expectViolation(
      group({ mentorMemberId: setup.otherMentorMemberId }),
      'mentorship_groups_mentor_in_cohort',
    );
  });

  it('requires the mentor to hold the mentor role', async () => {
    await expectViolation(
      group({ mentorMemberId: setup.studentMemberId }),
      'mentorship_groups_mentor_in_cohort',
    );
  });

  it('keeps a name unique per cohort, ignoring case', async () => {
    await group();
    await expectViolation(
      group({ name: 'pod a', mentorMemberId: setup.secondMentorMemberId }),
      'mentorship_groups_cohort_name_unique',
    );
    // The same name in another cohort is a different pod.
    await group({
      cohortId: fixtures.otherCohortId,
      mentorMemberId: setup.otherMentorMemberId,
    });
  });

  it('keeps a mentor to one group per cohort', async () => {
    await group();
    await expectViolation(
      group({ name: 'Pod B' }),
      'mentorship_groups_one_per_mentor',
    );
    // Another cohort is a different pod.
    await group({
      cohortId: fixtures.otherCohortId,
      mentorMemberId: setup.otherMentorMemberId,
    });
  });

  it('accepts a student of this cohort', async () => {
    const [row] = await group().returning();
    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: row.id,
      cohortId: fixtures.cohortId,
      cohortMemberId: setup.studentMemberId,
    });
  });

  it('requires the student link cohort to match the group', async () => {
    const [row] = await group().returning();
    await expectViolation(
      db.insert(mentorshipGroupStudents).values({
        mentorshipGroupId: row.id,
        cohortId: fixtures.otherCohortId,
        cohortMemberId: setup.otherStudentMemberId,
      }),
      'mentorship_group_students_group_fk',
    );
  });

  it('requires the student to be a member of the group cohort', async () => {
    const [row] = await group().returning();
    await expectViolation(
      db.insert(mentorshipGroupStudents).values({
        mentorshipGroupId: row.id,
        cohortId: fixtures.cohortId,
        cohortMemberId: setup.otherStudentMemberId,
      }),
      'mentorship_group_students_student_in_cohort',
    );
  });

  it('requires the student to hold the student role', async () => {
    const [row] = await group().returning();
    await expectViolation(
      db.insert(mentorshipGroupStudents).values({
        mentorshipGroupId: row.id,
        cohortId: fixtures.cohortId,
        cohortMemberId: setup.mentorMemberId,
      }),
      'mentorship_group_students_student_in_cohort',
    );
  });

  it('refuses the same student twice in one group', async () => {
    const [row] = await group().returning();
    const link = () =>
      db.insert(mentorshipGroupStudents).values({
        mentorshipGroupId: row.id,
        cohortId: fixtures.cohortId,
        cohortMemberId: setup.studentMemberId,
      });
    await link();
    await expectViolation(link(), 'mentorship_group_students_unique');
  });

  it('keeps a student to one group per cohort', async () => {
    const [first] = await group().returning();
    const [second] = await group({
      name: 'Pod B',
      mentorMemberId: setup.secondMentorMemberId,
    }).returning();

    await db.insert(mentorshipGroupStudents).values({
      mentorshipGroupId: first.id,
      cohortId: fixtures.cohortId,
      cohortMemberId: setup.studentMemberId,
    });
    await expectViolation(
      db.insert(mentorshipGroupStudents).values({
        mentorshipGroupId: second.id,
        cohortId: fixtures.cohortId,
        cohortMemberId: setup.studentMemberId,
      }),
      'mentorship_group_students_one_per_cohort',
    );
  });

  it('accepts an invite that names a group in its cohort', async () => {
    const [row] = await group().returning();
    await invite({
      cohortId: fixtures.cohortId,
      cohortTrackId: fixtures.cohortTrackId,
      cohortRole: CohortRole.Student,
      mentorshipGroupId: row.id,
    });
  });

  it('requires an invite group to be in the invite cohort', async () => {
    const [row] = await group({
      cohortId: fixtures.otherCohortId,
      mentorMemberId: setup.otherMentorMemberId,
    }).returning();
    await expectViolation(
      invite({
        cohortId: fixtures.cohortId,
        cohortTrackId: fixtures.cohortTrackId,
        cohortRole: CohortRole.Student,
        mentorshipGroupId: row.id,
      }),
      'invites_mentorship_group_cohort_fk',
    );
  });

  it('refuses a group on an invite that is not for a student', async () => {
    const [row] = await group().returning();
    await expectViolation(
      invite({
        cohortId: fixtures.cohortId,
        cohortRole: CohortRole.Professor,
        mentorshipGroupId: row.id,
      }),
      'invites_mentorship_group_student',
    );
  });
});

describe('notices', () => {
  const notice = (overrides: Partial<typeof notices.$inferInsert> = {}) =>
    db
      .insert(notices)
      .values({
        authorId: fixtures.adminId,
        scope: NoticeScope.Campus,
        title: 'Term starts on Monday',
        body: 'Classes resume on the 4th. Bring your laptop.',
        ...overrides,
      })
      .returning();

  /** One row per scope, each naming exactly the references its scope allows. */
  it('holds a notice in each of the three scopes', async () => {
    const [campus] = await notice();
    const [cohort] = await notice({
      scope: NoticeScope.Cohort,
      cohortId: fixtures.cohortId,
    });
    const [track] = await notice({
      scope: NoticeScope.CohortTrack,
      cohortId: fixtures.cohortId,
      cohortTrackId: fixtures.cohortTrackId,
      title: 'Track sync moved to Thursday',
    });

    const rows = await db.select().from(notices);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === campus.id)).toMatchObject({
      authorId: fixtures.adminId,
      scope: NoticeScope.Campus,
      cohortId: null,
      cohortTrackId: null,
      pinned: false,
      title: 'Term starts on Monday',
      body: 'Classes resume on the 4th. Bring your laptop.',
    });
    expect(rows.find((row) => row.id === cohort.id)).toMatchObject({
      scope: NoticeScope.Cohort,
      cohortId: fixtures.cohortId,
      cohortTrackId: null,
    });
    expect(rows.find((row) => row.id === track.id)).toMatchObject({
      scope: NoticeScope.CohortTrack,
      cohortId: fixtures.cohortId,
      cohortTrackId: fixtures.cohortTrackId,
    });
    expect(campus.createdAt).toBeInstanceOf(Date);
    expect(campus.updatedAt).toBeInstanceOf(Date);
  });

  it('refuses a campus notice that names a cohort', async () => {
    await expectViolation(
      notice({ scope: NoticeScope.Campus, cohortId: fixtures.cohortId }),
      'notices_cohort_matches_scope',
    );
  });

  /** The same rule read from the other side: a scoped notice needs its cohort. */
  it('refuses a cohort-scoped notice with no cohort', async () => {
    await expectViolation(
      notice({ scope: NoticeScope.Cohort }),
      'notices_cohort_matches_scope',
    );
  });

  it('refuses a track-scoped notice with no track', async () => {
    await expectViolation(
      notice({ scope: NoticeScope.CohortTrack, cohortId: fixtures.cohortId }),
      'notices_track_matches_scope',
    );
  });

  it('refuses a cohort notice that names a track', async () => {
    await expectViolation(
      notice({
        scope: NoticeScope.Cohort,
        cohortId: fixtures.cohortId,
        cohortTrackId: fixtures.cohortTrackId,
      }),
      'notices_track_matches_scope',
    );
  });

  it('requires the track to belong to the notice cohort', async () => {
    await expectViolation(
      notice({
        scope: NoticeScope.CohortTrack,
        cohortId: fixtures.cohortId,
        cohortTrackId: fixtures.otherCohortTrackId,
      }),
      'notices_cohort_track_fk',
    );
  });
});

describe('notifications', () => {
  let noticeId: string;

  const notice = () =>
    db
      .insert(notices)
      .values({
        authorId: fixtures.adminId,
        scope: NoticeScope.Campus,
        title: 'Term starts on Monday',
        body: 'Classes resume on the 4th.',
      })
      .returning();

  const alert = (overrides: Partial<typeof notifications.$inferInsert> = {}) =>
    db
      .insert(notifications)
      .values({
        recipientId: fixtures.adminId,
        kind: 'notice_posted',
        referenceType: 'notice',
        referenceId: noticeId,
        ...overrides,
      })
      .returning();

  beforeEach(async () => {
    const [row] = await notice();
    noticeId = row.id;
  });

  it('stores an alert for a recipient, unread until they read it', async () => {
    const [written] = await alert();
    const [row] = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.id} = ${written.id}`);

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      recipientId: fixtures.adminId,
      kind: 'notice_posted',
      referenceType: 'notice',
      referenceId: noticeId,
      readAt: null,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('refuses the same alert twice for the same person', async () => {
    await alert();

    await expectViolation(
      alert(),
      'notifications_recipient_kind_reference_unique',
    );

    // A different person, or a different event, is a different alert.
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'other@campus.local' })
      .returning();
    await expect(alert({ recipientId: otherUser.id })).resolves.toBeDefined();
    await expect(
      alert({ kind: 'entry_request_answered', referenceType: 'entry_request' }),
    ).resolves.toBeDefined();
  });

  /**
   * No foreign key on the reference: a notice that is removed must leave the
   * alert behind, as the record that it was once posted.
   */
  it('keeps the alert after the notice it points at is deleted', async () => {
    await alert();
    await db.delete(notices).where(sql`${notices.id} = ${noticeId}`);

    expect(await db.select().from(notices)).toHaveLength(0);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referenceId: noticeId });
  });
});

describe('comments', () => {
  const comment = (overrides: Partial<typeof comments.$inferInsert> = {}) =>
    db
      .insert(comments)
      .values({
        authorId: fixtures.adminId,
        targetType: CommentTargetType.Notice,
        // No foreign key on the target: any uuid is accepted.
        targetId: '00000000-0000-4000-8000-000000000001',
        body: 'I can help with the setup on Friday.',
        ...overrides,
      })
      .returning();

  it('requires an author that exists', async () => {
    await expectViolation(
      comment({ authorId: '00000000-0000-4000-8000-000000000000' }),
      'comments_author_id_users_id_fk',
    );
  });

  it('accepts only a known target type', async () => {
    await comment();

    await expectViolation(
      comment({ targetType: 'project' as CommentTargetType }),
      'comments_target_type_known',
    );
  });

  /**
   * The whole point of the polymorphic target: the row it names may be in a
   * table that does not exist yet, or one that has been deleted. There is no
   * foreign key here, so a target id matching nothing is by design.
   */
  it('accepts a target id that matches no notice', async () => {
    const [row] = await comment({
      targetId: '00000000-0000-4000-8000-000000000002',
    });

    expect(row.targetId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('keeps the body non-blank and within its limit', async () => {
    await expectViolation(
      comment({ body: ' \t\n' }),
      'comments_body_not_blank',
    );
    await expectViolation(
      comment({ body: 'x'.repeat(2001) }),
      'comments_body_length',
    );
  });
});
