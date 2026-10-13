import { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Db } from '../../infra/database/database.constants.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import { CohortMembersService } from './cohort-members.service.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const pglite = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers, auditLog },
});
const repository = new CohortMembersService(pglite as unknown as Db);

let userId: string;
let cohortId: string;
let cohortTrackId: string;
let baseTrackId: string;

beforeAll(async () => {
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await pglite.execute(sql`truncate audit_log, users, cohorts, tracks cascade`);

  [{ userId }] = await pglite
    .insert(users)
    .values({ email: 'ada@campus.local' })
    .returning({ userId: users.id });

  [{ cohortId }] = await pglite
    .insert(cohorts)
    .values({ name: 'Cohort 2', code: 'C2' })
    .returning({ cohortId: cohorts.id });

  const [{ trackId }] = await pglite
    .insert(tracks)
    .values({ name: 'Backend', code: 'BACKEND' })
    .returning({ trackId: tracks.id });
  baseTrackId = trackId;

  [{ cohortTrackId }] = await pglite
    .insert(cohortTracks)
    .values({ cohortId, trackId })
    .returning({ cohortTrackId: cohortTracks.id });
});

const student = (status: StudentStatus | null) => ({
  cohortId,
  userId,
  cohortTrackId,
  role: CohortRole.Student,
  status,
});

describe('hasActiveMembership', () => {
  it('is false for someone on no roster at all', async () => {
    expect(await repository.hasActiveMembership(userId)).toBe(false);
  });

  it('is true for a student in good standing', async () => {
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    expect(await repository.hasActiveMembership(userId)).toBe(true);
  });

  /**
   * This decides who signs in without an invite, so an enrolment nobody
   * finished is not enough. Staff are the ones who legitimately carry no
   * status — see the case below.
   */
  it('is false for a student nobody has classified yet', async () => {
    await pglite.insert(cohortMembers).values(student(null));

    expect(await repository.hasActiveMembership(userId)).toBe(false);
  });

  it('is true for staff, who never carry a student status', async () => {
    await pglite.insert(cohortMembers).values({
      cohortId,
      userId,
      role: CohortRole.Professor,
      status: null,
    });

    expect(await repository.hasActiveMembership(userId)).toBe(true);
  });

  it.each([
    StudentStatus.Dismissed,
    StudentStatus.Withdrawn,
    StudentStatus.Graduated,
    StudentStatus.Deferred,
  ])('is false once a student is %s', async (status) => {
    await pglite.insert(cohortMembers).values(student(status));

    expect(await repository.hasActiveMembership(userId)).toBe(false);
  });

  it('is false once someone has left, whatever their status says', async () => {
    await pglite
      .insert(cohortMembers)
      .values({ ...student(StudentStatus.Active), leftAt: new Date() });

    expect(await repository.hasActiveMembership(userId)).toBe(false);
  });

  it('is true when one membership ended and another is still running', async () => {
    const [{ id: otherCohort }] = await pglite
      .insert(cohorts)
      .values({ name: 'Cohort 1', code: 'C1' })
      .returning({ id: cohorts.id });

    await pglite.insert(cohortMembers).values([
      {
        ...student(StudentStatus.Graduated),
        cohortId: otherCohort,
        cohortTrackId: null,
        role: CohortRole.Mentor,
        status: null,
        leftAt: new Date(),
      },
      student(StudentStatus.Active),
    ]);

    expect(await repository.hasActiveMembership(userId)).toBe(true);
  });

  it('counts a guest while their visit is still running', async () => {
    await pglite.insert(cohortMembers).values({
      cohortId,
      userId,
      role: CohortRole.Guest,
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(await repository.hasActiveMembership(userId)).toBe(true);
  });

  /** A visit that has ended is not a way back in. */
  it('stops counting a guest once their visit has ended', async () => {
    await pglite.insert(cohortMembers).values({
      cohortId,
      userId,
      role: CohortRole.Guest,
      accessExpiresAt: new Date(Date.now() - 1_000),
    });

    expect(await repository.hasActiveMembership(userId)).toBe(false);
  });

  it('does not count somebody else’s membership', async () => {
    const [{ id: stranger }] = await pglite
      .insert(users)
      .values({ email: 'grace@campus.local' })
      .returning({ id: users.id });

    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    expect(await repository.hasActiveMembership(stranger)).toBe(false);
  });
});

describe('extendGuestVisit', () => {
  let now: Date;

  beforeEach(() => {
    now = new Date();
  });

  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  const guest = (accessExpiresAt: Date) => ({
    cohortId,
    userId,
    role: CohortRole.Guest,
    accessExpiresAt,
  });

  const storedVisit = async () => {
    const [row] = await pglite
      .select({ accessExpiresAt: cohortMembers.accessExpiresAt })
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, userId));
    return row.accessExpiresAt;
  };

  it('moves a running visit forward and records it once', async () => {
    const previous = at(60_000);
    const next = at(3_600_000);
    await pglite.insert(cohortMembers).values(guest(previous));

    const row = await repository.extendGuestVisit(
      cohortId,
      userId,
      next,
      { actorUserId: userId },
      now,
    );

    expect(row).toMatchObject({
      id: expect.any(String),
      cohortId,
      userId,
      role: CohortRole.Guest,
      accessExpiresAt: next,
    });
    expect(await storedVisit()).toEqual(next);

    const entries = await pglite.select().from(auditLog);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: AuditAction.GuestVisitExtended,
      subjectType: AuditSubjectType.CohortMember,
      subjectId: row.id,
      actorUserId: userId,
      details: {
        cohortId,
        accessExpiresAt: next.toISOString(),
        previousAccessExpiresAt: previous.toISOString(),
      },
    });
  });

  /**
   * The guest accepted a link with a deadline on it. Reopening an ended
   * visit from here would give back access the deadline closed, with no
   * invite recording that they were asked back.
   */
  it('refuses a visit that has already ended, and records nothing', async () => {
    const previous = at(-60_000);
    await pglite.insert(cohortMembers).values(guest(previous));

    await expect(
      repository.extendGuestVisit(
        cohortId,
        userId,
        at(3_600_000),
        { actorUserId: userId },
        now,
      ),
    ).rejects.toThrow(/visit has already ended/);

    expect(await storedVisit()).toEqual(previous);
    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a membership that has left', async () => {
    await pglite
      .insert(cohortMembers)
      .values({ ...guest(at(3_600_000)), leftAt: at(-60_000) });

    await expect(
      repository.extendGuestVisit(
        cohortId,
        userId,
        at(7_200_000),
        { actorUserId: userId },
        now,
      ),
    ).rejects.toThrow(/membership has already ended/);

    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses somebody whose place is not a visit', async () => {
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    await expect(
      repository.extendGuestVisit(
        cohortId,
        userId,
        at(3_600_000),
        { actorUserId: userId },
        now,
      ),
    ).rejects.toThrow(/Only a guest/);

    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses an end date that is not in the future', async () => {
    await pglite.insert(cohortMembers).values(guest(at(3_600_000)));

    await expect(
      repository.extendGuestVisit(
        cohortId,
        userId,
        at(-60_000),
        { actorUserId: userId },
        now,
      ),
    ).rejects.toMatchObject({
      code: ExceptionCode.InvalidArgument,
      details: {
        fields: { accessExpiresAt: expect.stringMatching(/in the future/) },
      },
    });

    expect(await storedVisit()).toEqual(at(3_600_000));
    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses an end date no later than the one already set', async () => {
    const previous = at(3_600_000);
    await pglite.insert(cohortMembers).values(guest(previous));

    await expect(
      repository.extendGuestVisit(
        cohortId,
        userId,
        previous,
        { actorUserId: userId },
        now,
      ),
    ).rejects.toMatchObject({
      code: ExceptionCode.InvalidArgument,
      details: {
        fields: {
          accessExpiresAt: expect.stringMatching(/later than the visit end/),
        },
      },
    });

    expect(await storedVisit()).toEqual(previous);
    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a membership nobody in that cohort has', async () => {
    const [{ id: stranger }] = await pglite
      .insert(users)
      .values({ email: 'grace@campus.local' })
      .returning({ id: users.id });

    await expect(
      repository.extendGuestVisit(
        cohortId,
        stranger,
        at(3_600_000),
        { actorUserId: userId },
        now,
      ),
    ).rejects.toThrow(/No membership/);

    expect(await pglite.select().from(auditLog)).toHaveLength(0);
  });
});

describe('moveMemberTrack', () => {
  let adminId: string;

  const actor = () => ({ actorUserId: adminId });

  const membershipOf = async (id = userId, cohort = cohortId) => {
    const [row] = await pglite
      .select()
      .from(cohortMembers)
      .where(
        and(eq(cohortMembers.userId, id), eq(cohortMembers.cohortId, cohort)),
      );
    return row;
  };

  // Only the moves, so the cohort fixture's own setup does not have to be
  // accounted for.
  const entries = () =>
    pglite
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditAction.MemberTrackChanged))
      .orderBy(auditLog.createdAt);

  /** A fresh catalogue track, attached to a cohort, so it is one it runs. */
  const attachTrack = async (
    options: { cohort?: string; name?: string; code?: string } = {},
  ) => {
    const [{ id: trackId }] = await pglite
      .insert(tracks)
      .values({
        name: options.name ?? 'Data',
        code: options.code ?? 'DATA',
      })
      .returning({ id: tracks.id });
    const [{ id: linkId }] = await pglite
      .insert(cohortTracks)
      .values({ cohortId: options.cohort ?? cohortId, trackId })
      .returning({ id: cohortTracks.id });
    return { trackId, linkId };
  };

  beforeEach(async () => {
    [{ userId: adminId }] = await pglite
      .insert(users)
      .values({ email: 'admin@campus.local' })
      .returning({ userId: users.id });
  });

  it('moves the student, and records the old and new track once', async () => {
    const target = await attachTrack({ name: 'Data', code: 'DATA' });
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));
    const before = await membershipOf();

    const row = await repository.moveMemberTrack(
      cohortId,
      userId,
      target.trackId,
      actor(),
    );

    expect(row).toEqual({
      id: before.id,
      cohortId,
      userId,
      role: CohortRole.Student,
      track: { id: target.trackId, name: 'Data', code: 'DATA' },
    });
    expect(await membershipOf()).toMatchObject({
      cohortTrackId: target.linkId,
      role: CohortRole.Student,
      status: StudentStatus.Active,
      leftAt: null,
      joinedAt: before.joinedAt,
    });

    expect(await entries()).toEqual([
      expect.objectContaining({
        actorUserId: adminId,
        action: AuditAction.MemberTrackChanged,
        subjectType: AuditSubjectType.CohortMember,
        subjectId: before.id,
        details: {
          cohortId,
          trackId: target.trackId,
          previousTrackId: baseTrackId,
        },
      }),
    ]);
  });

  it('refuses a track this cohort does not run, even a real one', async () => {
    const [{ id: otherCohort }] = await pglite
      .insert(cohorts)
      .values({ name: 'Cohort 3', code: 'C3' })
      .returning({ id: cohorts.id });
    const target = await attachTrack({
      cohort: otherCohort,
      name: 'Data',
      code: 'DATA',
    });
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    await expect(
      repository.moveMemberTrack(cohortId, userId, target.trackId, actor()),
    ).rejects.toMatchObject({
      code: ExceptionCode.Conflict,
      details: { cohortId, trackId: target.trackId },
    });

    expect((await membershipOf()).cohortTrackId).toBe(cohortTrackId);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses a track id that names no track, and writes nothing', async () => {
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));
    const missing = '99999999-9999-4999-8999-999999999999';

    await expect(
      repository.moveMemberTrack(cohortId, userId, missing, actor()),
    ).rejects.toMatchObject({ code: ExceptionCode.NotFound });

    expect((await membershipOf()).cohortTrackId).toBe(cohortTrackId);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses someone with no membership in the cohort', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';

    await expect(
      repository.moveMemberTrack(cohortId, missing, baseTrackId, actor()),
    ).rejects.toMatchObject({ code: ExceptionCode.NotFound });

    expect(await entries()).toHaveLength(0);
  });

  it('refuses a membership that has already ended', async () => {
    const target = await attachTrack();
    await pglite.insert(cohortMembers).values({
      ...student(StudentStatus.Active),
      leftAt: new Date(),
    });

    await expect(
      repository.moveMemberTrack(cohortId, userId, target.trackId, actor()),
    ).rejects.toMatchObject({ code: ExceptionCode.Conflict });

    expect((await membershipOf()).cohortTrackId).toBe(cohortTrackId);
    expect(await entries()).toHaveLength(0);
  });

  it.each([CohortRole.Professor, CohortRole.Mentor])(
    'refuses a %s, who has no student track to move',
    async (role) => {
      const target = await attachTrack();
      await pglite
        .insert(cohortMembers)
        .values({ cohortId, userId, role, status: null });

      await expect(
        repository.moveMemberTrack(cohortId, userId, target.trackId, actor()),
      ).rejects.toMatchObject({ code: ExceptionCode.Conflict });

      expect(await entries()).toHaveLength(0);
    },
  );

  it('refuses a guest', async () => {
    const target = await attachTrack();
    await pglite.insert(cohortMembers).values({
      cohortId,
      userId,
      role: CohortRole.Guest,
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await expect(
      repository.moveMemberTrack(cohortId, userId, target.trackId, actor()),
    ).rejects.toMatchObject({ code: ExceptionCode.Conflict });

    expect(await entries()).toHaveLength(0);
  });

  it('refuses moving to the track they are already on', async () => {
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    await expect(
      repository.moveMemberTrack(cohortId, userId, baseTrackId, actor()),
    ).rejects.toMatchObject({ code: ExceptionCode.Conflict });

    expect((await membershipOf()).cohortTrackId).toBe(cohortTrackId);
    expect(await entries()).toHaveLength(0);
  });

  it("leaves the same student's membership in another cohort alone", async () => {
    const [{ id: otherCohort }] = await pglite
      .insert(cohorts)
      .values({ name: 'Cohort 3', code: 'C3' })
      .returning({ id: cohorts.id });
    const other = await attachTrack({
      cohort: otherCohort,
      name: 'Design',
      code: 'PD',
    });
    const target = await attachTrack();
    await pglite.insert(cohortMembers).values([
      student(StudentStatus.Active),
      {
        cohortId: otherCohort,
        userId,
        cohortTrackId: other.linkId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
      },
    ]);

    await repository.moveMemberTrack(cohortId, userId, target.trackId, actor());

    expect((await membershipOf(userId, otherCohort)).cohortTrackId).toBe(
      other.linkId,
    );
    expect(await entries()).toHaveLength(1);
  });

  /**
   * The entry commits with the change, so a fault writing it takes the move
   * with it. The actor id is a foreign key, so one that names no account is a
   * real failure of the same insert, after the row was updated.
   */
  it('rolls the move back when the entry cannot be written', async () => {
    const target = await attachTrack();
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));
    const missing = '99999999-9999-4999-8999-999999999999';

    await expect(
      repository.moveMemberTrack(cohortId, userId, target.trackId, {
        actorUserId: missing,
      }),
    ).rejects.toThrow();

    expect((await membershipOf()).cohortTrackId).toBe(cohortTrackId);
    expect(await entries()).toHaveLength(0);
  });

  it('records the second move against the first move’s new track', async () => {
    const first = await attachTrack({ name: 'Data', code: 'DATA' });
    const second = await attachTrack({ name: 'Design', code: 'PD' });
    await pglite.insert(cohortMembers).values(student(StudentStatus.Active));

    await repository.moveMemberTrack(cohortId, userId, first.trackId, actor());
    await repository.moveMemberTrack(cohortId, userId, second.trackId, actor());

    const written = await entries();
    expect(written).toHaveLength(2);
    expect(written[0].details).toMatchObject({
      trackId: first.trackId,
      previousTrackId: baseTrackId,
    });
    expect(written[1].details).toMatchObject({
      trackId: second.trackId,
      previousTrackId: first.trackId,
    });
  });
});
