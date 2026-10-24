import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { InviteStatus, invites } from '../invites/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { DashboardService } from './dashboard.service.js';

/** Against a real engine: the live rule and the counting are SQL. */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers, invites },
});
const service = new DashboardService(db as never);

const DAY = 86_400_000;
const NOW = new Date('2026-10-23T12:00:00Z');

let c1: string;
let c2: string;
let c1se: string;
let c2se: string;
let admin: string;

const person = async (email: string) => {
  const [row] = await db.insert(users).values({ email }).returning();
  return row.id;
};

const join = (
  userId: string,
  cohortId: string,
  role: CohortRole,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) =>
  db.insert(cohortMembers).values({
    userId,
    cohortId,
    role,
    ...(role === CohortRole.Student
      ? {
          cohortTrackId: cohortId === c1 ? c1se : c2se,
          status: StudentStatus.Active,
        }
      : {}),
    ...(role === CohortRole.Guest
      ? { accessExpiresAt: new Date(NOW.getTime() + DAY) }
      : {}),
    ...overrides,
  });

const invite = (
  email: string,
  overrides: Partial<typeof invites.$inferInsert> = {},
) =>
  db.insert(invites).values({
    email,
    cohortId: c1,
    cohortRole: CohortRole.Professor,
    tokenHash: email,
    invitedBy: admin,
    expiresAt: new Date(NOW.getTime() + DAY),
    ...overrides,
  });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate invites, cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );
  const [se] = await db
    .insert(tracks)
    .values({ name: 'Software Engineering', code: 'SE' })
    .returning();
  const [cohort1, cohort2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort 1', code: 'C1' },
      { name: 'Cohort 2', code: 'C2' },
    ])
    .returning();
  const [l1, l2] = await db
    .insert(cohortTracks)
    .values([
      { cohortId: cohort1.id, trackId: se.id },
      { cohortId: cohort2.id, trackId: se.id },
    ])
    .returning();
  [c1, c2, c1se, c2se] = [cohort1.id, cohort2.id, l1.id, l2.id];
  admin = await person('admin@campus.local');
});

describe('DashboardService', () => {
  it('counts live members by role, each person once in the campus total', async () => {
    const ada = await person('ada@campus.local');
    const grace = await person('grace@campus.local');
    const linus = await person('linus@campus.local');
    await join(ada, c1, CohortRole.Student);
    await join(ada, c2, CohortRole.Mentor);
    await join(grace, c1, CohortRole.Professor);
    await join(linus, c2, CohortRole.Guest);

    await expect(service.figures(undefined, NOW)).resolves.toMatchObject({
      members: {
        total: 3,
        byRole: { student: 1, professor: 1, mentor: 1, guest: 1 },
      },
    });
  });

  it('counts one cohort when asked', async () => {
    const ada = await person('ada@campus.local');
    const grace = await person('grace@campus.local');
    await join(ada, c1, CohortRole.Student);
    await join(grace, c2, CohortRole.Student);

    await expect(service.figures(c1, NOW)).resolves.toMatchObject({
      members: {
        total: 1,
        byRole: { student: 1, professor: 0, mentor: 0, guest: 0 },
      },
    });
  });

  it('leaves out memberships that are not live', async () => {
    const ended = await person('ended@campus.local');
    const deferred = await person('deferred@campus.local');
    const expired = await person('expired@campus.local');
    await join(ended, c1, CohortRole.Professor, { leftAt: NOW });
    await join(deferred, c1, CohortRole.Student, {
      status: StudentStatus.Deferred,
    });
    await join(expired, c1, CohortRole.Guest, {
      accessExpiresAt: new Date(NOW.getTime() - 1),
    });

    await expect(service.figures(undefined, NOW)).resolves.toMatchObject({
      members: { total: 0 },
    });
  });

  it('counts pending invites not yet expired, admin invites in the campus total only', async () => {
    await invite('pending@campus.local');
    await invite('elsewhere@campus.local', { cohortId: c2 });
    await invite('new-admin@campus.local', {
      cohortId: null,
      cohortRole: null,
      systemRole: SystemRole.Admin,
    });
    await invite('lapsed@campus.local', {
      expiresAt: new Date(NOW.getTime() - 1),
    });
    await invite('accepted@campus.local', { status: InviteStatus.Accepted });
    await invite('revoked@campus.local', {
      status: InviteStatus.Revoked,
      revokedAt: NOW,
      revokedBy: admin,
    });

    await expect(service.figures(undefined, NOW)).resolves.toMatchObject({
      pendingInvites: 3,
    });
    await expect(service.figures(c1, NOW)).resolves.toMatchObject({
      pendingInvites: 1,
    });
  });

  it('answers zeros for an empty campus', async () => {
    await expect(service.figures(undefined, NOW)).resolves.toEqual({
      members: {
        total: 0,
        byRole: { student: 0, professor: 0, mentor: 0, guest: 0 },
      },
      pendingInvites: 0,
    });
  });

  it('refuses a cohort that does not exist', async () => {
    await expect(
      service.figures('99999999-9999-4999-8999-999999999999', NOW),
    ).rejects.toBeInstanceOf(CohortNotFoundException);
  });
});
