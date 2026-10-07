import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../../shared/auth/authenticated-user.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from '../../cohorts/schema.js';
import { tracks } from '../../tracks/schema.js';
import { ProfileService } from './profile.service.js';
import { SystemRole, UserStatus, users } from '../schema.js';
import { ProfileNotFoundException } from '../users.exceptions.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, cohortMembers },
});

const service = new ProfileService(db as never);

let c1: string;
let c2: string;
let c1se: string;

const person = async (
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(users)
    .values({ email, ...overrides })
    .returning();
  return row;
};

const viewerOf = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});

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
      ? { cohortTrackId: c1se, status: StudentStatus.Active }
      : {}),
    ...overrides,
  });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate cohort_members, cohort_tracks, cohorts, tracks, users cascade`,
  );

  const [track] = await db
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
  const [link] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort1.id, trackId: track.id })
    .returning();
  [c1, c2, c1se] = [cohort1.id, cohort2.id, link.id];
});

describe('own profile', () => {
  it('reads everything, the phone and the memberships included', async () => {
    const ada = await person('ada@campus.local', {
      firstName: 'Ada',
      phone: '+234 801 234 5678',
      providerId: 'google-subject-1',
    });
    await join(ada.id, c1, CohortRole.Student);

    const profile = await service.getOwn(ada.id);

    expect(profile).toMatchObject({
      id: ada.id,
      email: 'ada@campus.local',
      firstName: 'Ada',
      phone: '+234 801 234 5678',
      systemRole: SystemRole.User,
      memberships: [
        {
          cohort: { id: c1, name: 'Cohort 1', code: 'C1' },
          track: { name: 'Software Engineering', code: 'SE' },
          role: CohortRole.Student,
        },
      ],
    });
    expect(JSON.stringify(profile)).not.toContain('google-subject-1');
  });

  it('changes only the fields it was sent', async () => {
    const ada = await person('ada@campus.local', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      bio: 'First programmer.',
    });

    const profile = await service.updateOwn(ada.id, { displayName: 'Ada L.' });

    expect(profile).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L.',
      bio: 'First programmer.',
    });
  });

  it('clears a field sent as null, and leaves the rest', async () => {
    const ada = await person('ada@campus.local', {
      firstName: 'Ada',
      bio: 'First programmer.',
    });

    const profile = await service.updateOwn(ada.id, { bio: null });

    expect(profile.bio).toBeNull();
    expect(profile.firstName).toBe('Ada');
  });

  it('writes nothing for an update that names no field', async () => {
    const ada = await person('ada@campus.local');

    await service.updateOwn(ada.id, {});

    const [row] = await db.select().from(users).where(eq(users.id, ada.id));
    expect(row.updatedAt).toEqual(ada.updatedAt);
  });

  // The DTO has no such fields, and a body that carried them anyway would be
  // an object with extra keys: the service names what it writes.
  it('cannot be used to change the address, the role or the status', async () => {
    const ada = await person('ada@campus.local');

    await service.updateOwn(ada.id, {
      firstName: 'Ada',
      email: 'admin@campus.local',
      systemRole: SystemRole.Admin,
      status: UserStatus.Suspended,
    } as never);

    const [row] = await db.select().from(users).where(eq(users.id, ada.id));
    expect(row).toMatchObject({
      firstName: 'Ada',
      email: 'ada@campus.local',
      systemRole: SystemRole.User,
      status: UserStatus.Active,
    });
  });

  it('404s an account that is not there', async () => {
    await expect(
      service.getOwn('99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });
});

describe('profile card', () => {
  let ada: typeof users.$inferSelect;
  let grace: typeof users.$inferSelect;

  beforeEach(async () => {
    ada = await person('ada@campus.local', {
      firstName: 'Ada',
      phone: '+234 801 234 5678',
      bio: 'First programmer.',
    });
    grace = await person('grace@campus.local');
    await join(ada.id, c1, CohortRole.Student);
  });

  it('shows a classmate the card, with the address and without the phone', async () => {
    await join(grace.id, c1, CohortRole.Mentor);

    const card = await service.getCard(viewerOf(grace), ada.id);

    expect(card).toMatchObject({
      id: ada.id,
      email: 'ada@campus.local',
      firstName: 'Ada',
      bio: 'First programmer.',
    });
    expect(card).not.toHaveProperty('phone');
    expect(JSON.stringify(card)).not.toContain('801 234');
  });

  it('shows only the cohorts the two share', async () => {
    await join(ada.id, c2, CohortRole.Mentor);
    await join(grace.id, c1, CohortRole.Mentor);

    const card = await service.getCard(viewerOf(grace), ada.id);

    expect(card.memberships).toEqual([
      {
        cohort: { id: c1, name: 'Cohort 1', code: 'C1' },
        track: expect.objectContaining({ code: 'SE' }),
        role: CohortRole.Student,
      },
    ]);
  });

  it('404s somebody the viewer shares no cohort with', async () => {
    await join(grace.id, c2, CohortRole.Mentor);

    await expect(
      service.getCard(viewerOf(grace), ada.id),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });

  it('404s a viewer with no cohort at all', async () => {
    await expect(
      service.getCard(viewerOf(grace), ada.id),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });

  // A cohort either of them has left is not one they share.
  it.each([
    ['the viewer has left', 'viewer'],
    ['the other person has left', 'target'],
  ])('404s when %s the shared cohort', async (_label, who) => {
    await join(grace.id, c1, CohortRole.Mentor);
    await db
      .update(cohortMembers)
      .set({ leftAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(cohortMembers.userId, who === 'viewer' ? grace.id : ada.id));

    await expect(
      service.getCard(viewerOf(grace), ada.id),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });

  it('keeps a guest to the cohort they were invited to', async () => {
    await db.insert(cohortMembers).values({
      userId: grace.id,
      cohortId: c2,
      role: CohortRole.Guest,
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await expect(
      service.getCard(viewerOf(grace), ada.id),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });

  it('404s a suspended account to a classmate', async () => {
    await join(grace.id, c1, CohortRole.Mentor);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, ada.id));

    await expect(
      service.getCard(viewerOf(grace), ada.id),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });

  it('shows an admin anybody, every cohort, suspended or not', async () => {
    const admin = await person('admin@campus.local', {
      systemRole: SystemRole.Admin,
    });
    await join(ada.id, c2, CohortRole.Mentor);
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, ada.id));

    const card = await service.getCard(viewerOf(admin), ada.id);

    expect(card.memberships).toHaveLength(2);
    expect(card).not.toHaveProperty('phone');
  });

  // The role above admin has every admin power: a check against `admin`
  // alone would show a super admin less than the admins they appoint.
  it('shows a super admin what it shows an admin', async () => {
    const root = await person('root@campus.local', {
      systemRole: SystemRole.SuperAdmin,
    });
    await db
      .update(users)
      .set({ status: UserStatus.Suspended })
      .where(eq(users.id, ada.id));

    const card = await service.getCard(viewerOf(root), ada.id);

    expect(card.id).toBe(ada.id);
  });

  it('shows a person their own card, with no cohort needed', async () => {
    const card = await service.getCard(viewerOf(grace), grace.id);

    expect(card).toMatchObject({ id: grace.id, memberships: [] });
  });

  it('404s an id that is nobody', async () => {
    await expect(
      service.getCard(viewerOf(grace), '99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(ProfileNotFoundException);
  });
});
