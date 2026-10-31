import { PROFILE_CHANGED_CHANNEL } from '@campus/session';
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
import { AnalyticsConsent, SystemRole, UserStatus, users } from '../schema.js';
import {
  CohortProfilesForbiddenException,
  ProfileNotFoundException,
} from '../users.exceptions.js';
import { CohortNotFoundException } from '../../cohorts/cohorts.exceptions.js';

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

  it('changes the sprite, and clears it when sent null', async () => {
    const ada = await person('ada@campus.local');

    expect(
      (await service.updateOwn(ada.id, { spriteKey: 'placeholder-2' }))
        .spriteKey,
    ).toBe('placeholder-2');
    expect(
      (await service.updateOwn(ada.id, { spriteKey: null })).spriteKey,
    ).toBeNull();
  });

  /**
   * world listens on this channel to show the change to the person's cohort
   * straight away. Only for what others see: a new phone number is nobody
   * else's business, and world has nothing to redraw for it.
   */
  it('tells world when the sprite or display name changes, and not otherwise', async () => {
    const ada = await person('ada@campus.local');
    const heard: string[] = [];
    const stop = await db.$client.listen(PROFILE_CHANGED_CHANNEL, (payload) =>
      heard.push(payload),
    );
    try {
      await service.updateOwn(ada.id, { spriteKey: 'placeholder-2' });
      await service.updateOwn(ada.id, { displayName: 'Ada L.' });
      await service.updateOwn(ada.id, { phone: '+2348012345678', bio: 'Hi' });
      await vi.waitFor(() => expect(heard).toEqual([ada.id, ada.id]));
    } finally {
      await stop();
    }
  });

  it('says nothing to world when the update fails', async () => {
    const heard: string[] = [];
    const stop = await db.$client.listen(PROFILE_CHANGED_CHANNEL, (payload) =>
      heard.push(payload),
    );
    try {
      await expect(
        service.updateOwn('00000000-0000-4000-8000-000000000000', {
          spriteKey: 'placeholder-1',
        }),
      ).rejects.toThrow('No such profile');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard).toEqual([]);
    } finally {
      await stop();
    }
  });

  /**
   * When the list changes, what people picked from the old one is not
   * cleaned up. It reads as no sprite, so clients draw their default.
   */
  it('shows a sprite no longer on the list as none', async () => {
    const ada = await person('ada@campus.local', {
      spriteKey: 'retired-knight',
    });
    const grace = await person('grace@campus.local');
    await join(ada.id, c1, CohortRole.Mentor);
    await join(grace.id, c1, CohortRole.Mentor);

    expect((await service.getOwn(ada.id)).spriteKey).toBeNull();
    expect(
      (await service.getCard(viewerOf(grace), ada.id)).spriteKey,
    ).toBeNull();
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

describe('analytics consent', () => {
  it('is unset until they choose, then records the choice and when', async () => {
    const ada = await person('ada@campus.local');
    const decidedAt = new Date('2026-10-30T12:00:00.000Z');

    expect((await service.getOwn(ada.id)).analyticsConsent).toBeNull();

    const profile = await service.setAnalyticsConsent(
      ada.id,
      AnalyticsConsent.Granted,
      decidedAt,
    );

    expect(profile.analyticsConsent).toBe(AnalyticsConsent.Granted);
    const [row] = await db.select().from(users).where(eq(users.id, ada.id));
    expect(row.analyticsConsent).toBe(AnalyticsConsent.Granted);
    expect(row.analyticsConsentAt).toEqual(decidedAt);
  });

  it('can be withdrawn, and touches nobody else', async () => {
    const ada = await person('ada@campus.local');
    const grace = await person('grace@campus.local');

    await service.setAnalyticsConsent(ada.id, AnalyticsConsent.Granted);
    await service.setAnalyticsConsent(ada.id, AnalyticsConsent.Denied);

    expect((await service.getOwn(ada.id)).analyticsConsent).toBe(
      AnalyticsConsent.Denied,
    );
    expect((await service.getOwn(grace.id)).analyticsConsent).toBeNull();
  });

  it('is a not-found for an account that is gone', async () => {
    await expect(
      service.setAnalyticsConsent(
        '99999999-9999-4999-8999-999999999999',
        AnalyticsConsent.Denied,
      ),
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

  it('shows a classmate the sprite they picked', async () => {
    await join(grace.id, c1, CohortRole.Mentor);
    await service.updateOwn(ada.id, { spriteKey: 'placeholder-3' });

    const card = await service.getCard(viewerOf(grace), ada.id);

    expect(card.spriteKey).toBe('placeholder-3');
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

describe("a cohort's people", () => {
  const DAY = 86_400_000;

  it('lists everybody live in the cohort, sorted by name with the unnamed last', async () => {
    const ada = await person('ada@campus.local', { displayName: 'Ada' });
    const bob = await person('bob@campus.local', { displayName: 'Bob' });
    const cy = await person('cy@campus.local');
    const gone = await person('gone@campus.local', { displayName: 'Gone' });
    const elsewhere = await person('else@campus.local', {
      displayName: 'Else',
    });
    await join(cy.id, c1, CohortRole.Mentor);
    await join(bob.id, c1, CohortRole.Professor);
    await join(ada.id, c1, CohortRole.Student);
    await join(gone.id, c1, CohortRole.Professor, {
      leftAt: new Date(Date.now() - DAY),
    });
    await join(elsewhere.id, c2, CohortRole.Professor);

    const listed = await service.listCohort(viewerOf(ada), c1);

    expect(listed.map((entry) => entry.id)).toEqual([ada.id, bob.id, cy.id]);
    expect(listed[0]).toEqual({
      id: ada.id,
      displayName: 'Ada',
      spriteKey: null,
    });
  });

  it('sorts names without regard to case', async () => {
    const zed = await person('zed@campus.local', { displayName: 'Zed' });
    const ada = await person('ada@campus.local', { displayName: 'ada' });
    await join(zed.id, c1, CohortRole.Professor);
    await join(ada.id, c1, CohortRole.Professor);

    const listed = await service.listCohort(viewerOf(zed), c1);

    expect(listed.map((entry) => entry.displayName)).toEqual(['ada', 'Zed']);
  });

  it('gives a sprite that is offered, and null for one that is not', async () => {
    const ada = await person('ada@campus.local', {
      displayName: 'Ada',
      spriteKey: 'placeholder-2',
    });
    const bob = await person('bob@campus.local', {
      displayName: 'Bob',
      spriteKey: 'retired-sprite',
    });
    await join(ada.id, c1, CohortRole.Professor);
    await join(bob.id, c1, CohortRole.Professor);

    const listed = await service.listCohort(viewerOf(ada), c1);

    expect(listed.map((entry) => entry.spriteKey)).toEqual([
      'placeholder-2',
      null,
    ]);
  });

  it('leaves a suspended account out, except for an admin', async () => {
    const ada = await person('ada@campus.local', { displayName: 'Ada' });
    const banned = await person('banned@campus.local', {
      displayName: 'Banned',
      status: UserStatus.Suspended,
    });
    const admin = await person('admin@campus.local', {
      systemRole: SystemRole.Admin,
    });
    await join(ada.id, c1, CohortRole.Professor);
    await join(banned.id, c1, CohortRole.Professor);

    const seen = async (viewer: typeof users.$inferSelect) =>
      (await service.listCohort(viewerOf(viewer), c1)).map((entry) => entry.id);

    await expect(seen(ada)).resolves.toEqual([ada.id]);
    await expect(seen(admin)).resolves.toEqual([ada.id, banned.id]);
  });

  it('refuses somebody with no live place in the cohort', async () => {
    const outsider = await person('out@campus.local');
    const ended = await person('ended@campus.local');
    await join(outsider.id, c2, CohortRole.Professor);
    await join(ended.id, c1, CohortRole.Professor, {
      leftAt: new Date(Date.now() - DAY),
    });

    await expect(
      service.listCohort(viewerOf(outsider), c1),
    ).rejects.toBeInstanceOf(CohortProfilesForbiddenException);
    await expect(
      service.listCohort(viewerOf(ended), c1),
    ).rejects.toBeInstanceOf(CohortProfilesForbiddenException);
  });

  it('lets an admin read any cohort, and tells an admin when there is none', async () => {
    const admin = await person('admin@campus.local', {
      systemRole: SystemRole.Admin,
    });

    await expect(service.listCohort(viewerOf(admin), c2)).resolves.toEqual([]);
    await expect(
      service.listCohort(
        viewerOf(admin),
        '99999999-9999-4999-8999-999999999999',
      ),
    ).rejects.toBeInstanceOf(CohortNotFoundException);
  });
});
