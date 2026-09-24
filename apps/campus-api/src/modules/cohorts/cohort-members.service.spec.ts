import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Db } from '../../infra/database/database.constants.js';
import { users } from '../users/schema.js';
import { tracks } from '../tracks/schema.js';
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
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers },
});
const repository = new CohortMembersService(pglite as unknown as Db);

let userId: string;
let cohortId: string;
let cohortTrackId: string;

beforeAll(async () => {
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await pglite.execute(sql`truncate users, cohorts, tracks cascade`);

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
      { ...student(StudentStatus.Graduated), cohortId: otherCohort, cohortTrackId: null, role: CohortRole.Mentor, status: null, leftAt: new Date() },
      student(StudentStatus.Active),
    ]);

    expect(await repository.hasActiveMembership(userId)).toBe(true);
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
