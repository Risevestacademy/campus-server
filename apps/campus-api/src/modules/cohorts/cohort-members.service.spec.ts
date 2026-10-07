import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
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
