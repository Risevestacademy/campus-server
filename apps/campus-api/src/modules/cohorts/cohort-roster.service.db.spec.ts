import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { tracks } from '../tracks/schema.js';
import { UserStatus, users } from '../users/schema.js';
import { CohortRosterService } from './cohort-roster.service.js';
import { CohortNotFoundException } from './cohorts.exceptions.js';
import {
  MembershipState,
  RosterScope,
  type ListRosterQueryDto,
} from './dto/cohort-roster.dto.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './schema.js';

/**
 * Against a real engine (PGlite, committed migrations applied): the filters,
 * the live rule and the ordering are SQL, and a mocked query builder would
 * only prove they were called.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers },
});
const service = new CohortRosterService(db as never);

let c1: string;
let c2: string;
let se: string;
let pd: string;
let c1se: string;
let c1pd: string;

const person = async (
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(users)
    .values({ email, ...overrides })
    .returning();
  return row.id;
};

const join = (
  userId: string,
  role: CohortRole,
  overrides: Partial<typeof cohortMembers.$inferInsert> = {},
) =>
  db.insert(cohortMembers).values({
    userId,
    cohortId: c1,
    role,
    ...(role === CohortRole.Student
      ? { cohortTrackId: c1se, status: StudentStatus.Active }
      : {}),
    ...(role === CohortRole.Guest
      ? { accessExpiresAt: new Date(Date.now() + 86_400_000) }
      : {}),
    ...overrides,
  });

const emails = async (
  filters: Partial<ListRosterQueryDto> = {},
  cohortId = c1,
) => {
  const page = await service.list(cohortId, {
    page: 1,
    perPage: 50,
    state: RosterScope.Live,
    ...filters,
  });
  return page.items.map((item) => item.user.email);
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
  const [l1, l2] = await db
    .insert(cohortTracks)
    .values([
      { cohortId: cohort1.id, trackId: seTrack.id },
      { cohortId: cohort1.id, trackId: pdTrack.id },
    ])
    .returning();
  [c1, c2, se, pd, c1se, c1pd] = [
    cohort1.id,
    cohort2.id,
    seTrack.id,
    pdTrack.id,
    l1.id,
    l2.id,
  ];
});

describe('CohortRosterService', () => {
  it('lists each membership with the person, track and state', async () => {
    const ada = await person('ada@campus.local', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      providerId: 'google-subject-1',
    });
    await join(ada, CohortRole.Student);

    const page = await service.list(c1, {
      page: 1,
      perPage: 20,
      state: RosterScope.Live,
    });

    expect(page.meta).toEqual({
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    });
    expect(page.items[0]).toMatchObject({
      user: {
        id: ada,
        email: 'ada@campus.local',
        firstName: 'Ada',
        lastName: 'Lovelace',
        status: UserStatus.Active,
      },
      role: CohortRole.Student,
      track: { id: se, name: 'Software Engineering', code: 'SE' },
      status: StudentStatus.Active,
      state: MembershipState.Live,
      leftAt: null,
    });
    expect(JSON.stringify(page)).not.toContain('google-subject-1');
  });

  it('lists staff first, then students, then guests, by name within each', async () => {
    await join(await person('guest@campus.local'), CohortRole.Guest);
    await join(
      await person('zed@campus.local', { lastName: 'Zed' }),
      CohortRole.Student,
    );
    await join(
      await person('abel@campus.local', { lastName: 'abel' }),
      CohortRole.Student,
    );
    await join(await person('mentor@campus.local'), CohortRole.Mentor);
    await join(await person('prof@campus.local'), CohortRole.Professor);

    expect(await emails()).toEqual([
      'mentor@campus.local',
      'prof@campus.local',
      'abel@campus.local',
      'zed@campus.local',
      'guest@campus.local',
    ]);
  });

  // Staff are one group: a mentor called Abel comes before a professor
  // called Zed, and a professor called Baker sits between them.
  it('sorts professors and mentors together, by name', async () => {
    await join(
      await person('prof.zed@campus.local', { lastName: 'Zed' }),
      CohortRole.Professor,
    );
    await join(
      await person('mentor.abel@campus.local', { lastName: 'Abel' }),
      CohortRole.Mentor,
    );
    await join(
      await person('prof.baker@campus.local', { lastName: 'Baker' }),
      CohortRole.Professor,
    );
    await join(
      await person('student.aaron@campus.local', { lastName: 'Aaron' }),
      CohortRole.Student,
    );

    expect(await emails()).toEqual([
      'mentor.abel@campus.local',
      'prof.baker@campus.local',
      'prof.zed@campus.local',
      'student.aaron@campus.local',
    ]);
  });

  it('only lists the cohort it was asked about', async () => {
    const ada = await person('ada@campus.local');
    await join(ada, CohortRole.Student);
    await db
      .insert(cohortMembers)
      .values({ userId: ada, cohortId: c2, role: CohortRole.Mentor });
    await db.insert(cohortMembers).values({
      userId: await person('other@campus.local'),
      cohortId: c2,
      role: CohortRole.Professor,
    });

    expect(await emails()).toEqual(['ada@campus.local']);
    expect(await emails({}, c2)).toEqual([
      'ada@campus.local',
      'other@campus.local',
    ]);
  });

  describe('state', () => {
    beforeEach(async () => {
      await join(await person('active@campus.local'), CohortRole.Student);
      await join(await person('dismissed@campus.local'), CohortRole.Student, {
        status: StudentStatus.Dismissed,
        dismissalReason: 'Plagiarism.',
      });
      await join(await person('left@campus.local'), CohortRole.Mentor, {
        leftAt: new Date('2026-01-01T00:00:00Z'),
      });
      await join(await person('visited@campus.local'), CohortRole.Guest, {
        accessExpiresAt: new Date('2026-01-01T00:00:00Z'),
      });
      await join(await person('visiting@campus.local'), CohortRole.Guest);
    });

    it('lists only the people in the cohort now, by default', async () => {
      expect(await emails()).toEqual([
        'active@campus.local',
        'visiting@campus.local',
      ]);
    });

    it('lists those who are gone under ended, each said to be so', async () => {
      const page = await service.list(c1, {
        page: 1,
        perPage: 20,
        state: RosterScope.Ended,
      });

      expect(page.items.map((item) => item.user.email)).toEqual([
        'left@campus.local',
        'dismissed@campus.local',
        'visited@campus.local',
      ]);
      expect(
        page.items.every((item) => item.state === MembershipState.Ended),
      ).toBe(true);
      expect(page.items[1].dismissalReason).toBe('Plagiarism.');
    });

    it('lists everybody under all, and tells the two apart', async () => {
      const page = await service.list(c1, {
        page: 1,
        perPage: 20,
        state: RosterScope.All,
      });

      expect(page.meta.total).toBe(5);
      const states = Object.fromEntries(
        page.items.map((item) => [item.user.email, item.state]),
      );
      expect(states).toEqual({
        'active@campus.local': MembershipState.Live,
        'visiting@campus.local': MembershipState.Live,
        'left@campus.local': MembershipState.Ended,
        'dismissed@campus.local': MembershipState.Ended,
        'visited@campus.local': MembershipState.Ended,
      });
    });

    // Read against the clock, not off a column: nothing flips a guest's row
    // when their visit ends.
    it('files a guest under ended the moment their visit is over', async () => {
      const later = new Date(Date.now() + 2 * 86_400_000);

      const page = await service.list(
        c1,
        { page: 1, perPage: 20, state: RosterScope.Live },
        later,
      );

      expect(page.items.map((item) => item.user.email)).toEqual([
        'active@campus.local',
      ]);
    });
  });

  describe('filters', () => {
    beforeEach(async () => {
      await join(await person('se@campus.local'), CohortRole.Student);
      await join(await person('pd@campus.local'), CohortRole.Student, {
        cohortTrackId: c1pd,
      });
      await join(await person('prof@campus.local'), CohortRole.Professor);
      await join(await person('withdrawn@campus.local'), CohortRole.Student, {
        status: StudentStatus.Withdrawn,
      });
    });

    it('filters by role', async () => {
      expect(await emails({ role: CohortRole.Professor })).toEqual([
        'prof@campus.local',
      ]);
    });

    it('filters by track, with a total that matches', async () => {
      const page = await service.list(c1, {
        page: 1,
        perPage: 20,
        state: RosterScope.Live,
        trackId: pd,
      });

      expect(page.items.map((item) => item.user.email)).toEqual([
        'pd@campus.local',
      ]);
      expect(page.meta.total).toBe(1);
    });

    it('filters by student status, once ended memberships are in scope', async () => {
      expect(await emails({ status: StudentStatus.Withdrawn })).toEqual([]);
      expect(
        await emails({
          status: StudentStatus.Withdrawn,
          state: RosterScope.All,
        }),
      ).toEqual(['withdrawn@campus.local']);
    });

    it('combines filters', async () => {
      expect(await emails({ role: CohortRole.Student, trackId: se })).toEqual([
        'se@campus.local',
      ]);
      expect(await emails({ role: CohortRole.Professor, trackId: se })).toEqual(
        [],
      );
    });

    // A track is required of a student and allowed for anyone: an invite
    // may place a professor on one, and the roster says so rather than
    // hiding it.
    it('shows a track on staff who were placed on one, and finds them by it', async () => {
      await join(await person('pd.prof@campus.local'), CohortRole.Professor, {
        cohortTrackId: c1pd,
      });

      const page = await service.list(c1, {
        page: 1,
        perPage: 20,
        state: RosterScope.Live,
        trackId: pd,
      });

      expect(
        page.items.map((item) => [
          item.user.email,
          item.role,
          item.track?.code,
        ]),
      ).toEqual([
        ['pd.prof@campus.local', CohortRole.Professor, 'PD'],
        ['pd@campus.local', CohortRole.Student, 'PD'],
      ]);
      expect(await emails({ role: CohortRole.Student, trackId: pd })).toEqual([
        'pd@campus.local',
      ]);
    });
  });

  it('walks pages without repeating or dropping a row', async () => {
    for (let i = 0; i < 5; i += 1) {
      await join(await person(`s${i}@campus.local`), CohortRole.Student);
    }

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await service.list(c1, {
        page,
        perPage: 2,
        state: RosterScope.Live,
      });
      seen.push(...res.items.map((item) => item.user.email));
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('keeps a suspended account on the roster, and says it is suspended', async () => {
    await join(
      await person('gone@campus.local', { status: UserStatus.Suspended }),
      CohortRole.Student,
    );

    const page = await service.list(c1, {
      page: 1,
      perPage: 20,
      state: RosterScope.Live,
    });

    expect(page.items[0]).toMatchObject({
      state: MembershipState.Live,
      user: { status: UserStatus.Suspended },
    });
  });

  it('answers an empty cohort with an empty page', async () => {
    const page = await service.list(c2, {
      page: 1,
      perPage: 20,
      state: RosterScope.Live,
    });

    expect(page).toMatchObject({
      items: [],
      meta: { total: 0, totalPages: 0 },
    });
  });

  it('404s a cohort that does not exist', async () => {
    await expect(
      service.list('99999999-9999-4999-8999-999999999999', {
        page: 1,
        perPage: 20,
        state: RosterScope.Live,
      }),
    ).rejects.toBeInstanceOf(CohortNotFoundException);
  });
});
