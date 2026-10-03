import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import type { ListUsersQueryDto } from './dto/list-users.dto.js';
import { SystemRole, UserStatus, users } from './schema.js';
import { UserDirectoryService } from './user-directory.service.js';

/**
 * Against a real engine (PGlite, committed migrations applied): the filters
 * are SQL, and a mocked query builder would only prove they were called.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers },
});
const service = new UserDirectoryService(db as never);

/** Two cohorts, each running both tracks. */
let c1: string;
let c2: string;
let se: string;
let pd: string;
const link: Record<string, string> = {};

let sequence = 0;
const person = async (
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {},
) => {
  sequence += 1;
  const [row] = await db
    .insert(users)
    .values({
      email,
      // Spaced out, so newest-first is an order the test can name.
      createdAt: new Date(Date.UTC(2026, 0, 1) + sequence * 60_000),
      ...overrides,
    })
    .returning();
  return row.id;
};

const student = (
  userId: string,
  cohortId: string,
  cohortTrackId: string,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) =>
  db.insert(cohortMembers).values({
    userId,
    cohortId,
    cohortTrackId,
    role: CohortRole.Student,
    status: StudentStatus.Active,
    ...overrides,
  });

const staff = (
  userId: string,
  cohortId: string,
  role: CohortRole.Professor | CohortRole.Mentor,
) => db.insert(cohortMembers).values({ userId, cohortId, role });

const emails = async (filters: Partial<ListUsersQueryDto> = {}) => {
  const page = await service.list({ page: 1, perPage: 20, ...filters });
  return page.items.map((item) => item.email).sort();
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [seTrack, pdTrack] = await db
    .insert(tracks)
    .values([
      { name: 'Software Engineering', code: 'SE' },
      { name: 'Product Design', code: 'PD' },
    ])
    .returning();
  const [cohort1, cohort2] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort 1', code: 'C1' },
      { name: 'Cohort 2', code: 'C2' },
    ])
    .returning();
  [c1, c2, se, pd] = [cohort1.id, cohort2.id, seTrack.id, pdTrack.id];

  for (const [key, cohortId, trackId] of [
    ['c1se', c1, se],
    ['c1pd', c1, pd],
    ['c2se', c2, se],
    ['c2pd', c2, pd],
  ]) {
    const [row] = await db
      .insert(cohortTracks)
      .values({ cohortId, trackId })
      .returning();
    link[key] = row.id;
  }
});

describe('UserDirectoryService', () => {
  describe('everyone', () => {
    it('lists every account, newest first, with pagination totals', async () => {
      await person('first@campus.local');
      await person('second@campus.local');
      await person('third@campus.local');

      const page = await service.list({ page: 1, perPage: 2 });

      expect(page.items.map((item) => item.email)).toEqual([
        'third@campus.local',
        'second@campus.local',
      ]);
      expect(page.meta).toEqual({
        page: 1,
        perPage: 2,
        total: 3,
        totalPages: 2,
      });
    });

    it('lists somebody with no membership at all', async () => {
      await person('admin@campus.local', { systemRole: SystemRole.Admin });

      const page = await service.list({ page: 1, perPage: 20 });

      expect(page.items[0].memberships).toEqual([]);
    });

    it('never carries the Google subject', async () => {
      await person('ada@campus.local', { providerId: 'google-subject-1' });

      const page = await service.list({ page: 1, perPage: 20 });

      expect(JSON.stringify(page)).not.toContain('google-subject-1');
    });

    it('counts a person in two cohorts once, and shows both', async () => {
      const ada = await person('ada@campus.local');
      await student(ada, c1, link.c1se, {
        joinedAt: new Date('2026-01-01T00:00:00Z'),
      });
      await staff(ada, c2, CohortRole.Mentor);

      const page = await service.list({ page: 1, perPage: 20 });

      expect(page.meta.total).toBe(1);
      // Most recently joined first.
      expect(page.items[0].memberships).toMatchObject([
        {
          cohort: { id: c2, name: 'Cohort 2', code: 'C2' },
          track: null,
          role: CohortRole.Mentor,
          status: null,
        },
        {
          cohort: { id: c1, name: 'Cohort 1', code: 'C1' },
          track: { id: se, name: 'Software Engineering', code: 'SE' },
          role: CohortRole.Student,
          status: StudentStatus.Active,
        },
      ]);
    });
  });

  describe('account filters', () => {
    it('filters by system role', async () => {
      await person('admin@campus.local', { systemRole: SystemRole.Admin });
      await person('ada@campus.local');

      expect(await emails({ systemRole: SystemRole.Admin })).toEqual([
        'admin@campus.local',
      ]);
      expect(await emails({ systemRole: SystemRole.User })).toEqual([
        'ada@campus.local',
      ]);
    });

    it('filters by account status', async () => {
      await person('gone@campus.local', { status: UserStatus.Suspended });
      await person('ada@campus.local');

      expect(await emails({ status: UserStatus.Suspended })).toEqual([
        'gone@campus.local',
      ]);
    });

    it('searches the address and the names, ignoring case', async () => {
      await person('ada@campus.local', {
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      await person('grace@campus.local', { displayName: 'Amazing Grace' });
      await person('alan@campus.local');

      expect(await emails({ search: 'LOVE' })).toEqual(['ada@campus.local']);
      expect(await emails({ search: 'ada love' })).toEqual([
        'ada@campus.local',
      ]);
      expect(await emails({ search: 'amazing' })).toEqual([
        'grace@campus.local',
      ]);
      expect(await emails({ search: 'alan@' })).toEqual(['alan@campus.local']);
    });

    it('treats % and _ in a search as the characters they are', async () => {
      await person('a_b@campus.local');
      await person('axb@campus.local');

      expect(await emails({ search: 'a_b' })).toEqual(['a_b@campus.local']);
      expect(await emails({ search: '%' })).toEqual([]);
    });
  });

  describe('membership filters', () => {
    let c1seStudent: string;
    let c1pdStudent: string;
    let c2seStudent: string;
    let c1Professor: string;

    beforeEach(async () => {
      c1seStudent = await person('c1se@campus.local');
      c1pdStudent = await person('c1pd@campus.local');
      c2seStudent = await person('c2se@campus.local');
      c1Professor = await person('c1prof@campus.local');
      await person('nobody@campus.local');
      await student(c1seStudent, c1, link.c1se);
      await student(c1pdStudent, c1, link.c1pd);
      await student(c2seStudent, c2, link.c2se);
      await staff(c1Professor, c1, CohortRole.Professor);
    });

    it('filters by cohort, whatever the role', async () => {
      expect(await emails({ cohortId: c1 })).toEqual([
        'c1pd@campus.local',
        'c1prof@campus.local',
        'c1se@campus.local',
      ]);
    });

    it('filters by track across cohorts', async () => {
      expect(await emails({ trackId: se })).toEqual([
        'c1se@campus.local',
        'c2se@campus.local',
      ]);
    });

    it('filters by cohort and track together', async () => {
      expect(await emails({ cohortId: c1, trackId: se })).toEqual([
        'c1se@campus.local',
      ]);
    });

    it('filters by cohort role', async () => {
      expect(await emails({ cohortRole: CohortRole.Professor })).toEqual([
        'c1prof@campus.local',
      ]);
    });

    it('needs one membership to satisfy every membership filter', async () => {
      // A student in cohort 1 who mentors cohort 2: in cohort 1, and a
      // mentor, but not a mentor in cohort 1.
      await staff(c1seStudent, c2, CohortRole.Mentor);

      expect(
        await emails({ cohortId: c1, cohortRole: CohortRole.Mentor }),
      ).toEqual([]);
      expect(
        await emails({ cohortId: c2, cohortRole: CohortRole.Mentor }),
      ).toEqual(['c1se@campus.local']);
    });

    it('combines membership filters with account filters', async () => {
      await db
        .update(users)
        .set({ status: UserStatus.Suspended })
        .where(sql`${users.id} = ${c1pdStudent}`);

      expect(
        await emails({ cohortId: c1, status: UserStatus.Suspended }),
      ).toEqual(['c1pd@campus.local']);
    });

    it('leaves out a membership that has ended', async () => {
      const left = await person('left@campus.local');
      const dismissed = await person('dismissed@campus.local');
      const visited = await person('visited@campus.local');
      await db.insert(cohortMembers).values({
        userId: left,
        cohortId: c2,
        role: CohortRole.Mentor,
        leftAt: new Date('2026-01-01T00:00:00Z'),
      });
      await student(dismissed, c2, link.c2pd, {
        status: StudentStatus.Dismissed,
      });
      await db.insert(cohortMembers).values({
        userId: visited,
        cohortId: c2,
        role: CohortRole.Guest,
        accessExpiresAt: new Date('2026-01-01T00:00:00Z'),
      });

      expect(await emails({ cohortId: c2 })).toEqual(['c2se@campus.local']);
      // Still an account, so still in the unfiltered list — with nothing
      // live to show.
      const page = await service.list({
        page: 1,
        perPage: 20,
        search: 'dismissed',
      });
      expect(page.items[0].memberships).toEqual([]);
    });

    // The roster, not access: a suspended account cannot sign in, but it
    // still holds its places, and `status` is what says it is suspended.
    it('lists a suspended account with the memberships it still holds', async () => {
      await db
        .update(users)
        .set({ status: UserStatus.Suspended })
        .where(sql`${users.id} = ${c1seStudent}`);

      const page = await service.list({ page: 1, perPage: 20, cohortId: c1 });
      const found = page.items.find(
        (item) => item.email === 'c1se@campus.local',
      );

      expect(found?.status).toBe(UserStatus.Suspended);
      expect(found?.memberships).toHaveLength(1);
      expect(
        await emails({ cohortId: c1, status: UserStatus.Active }),
      ).not.toContain('c1se@campus.local');
    });

    it('shows every membership of somebody a filter found by one', async () => {
      await staff(c1seStudent, c2, CohortRole.Mentor);

      const page = await service.list({ page: 1, perPage: 20, trackId: se });
      const found = page.items.find(
        (item) => item.email === 'c1se@campus.local',
      );

      expect(found?.memberships).toHaveLength(2);
    });

    it('answers an unknown cohort with an empty page', async () => {
      const page = await service.list({
        page: 1,
        perPage: 20,
        cohortId: '99999999-9999-4999-8999-999999999999',
      });

      expect(page.items).toEqual([]);
      expect(page.meta.total).toBe(0);
    });
  });
});
