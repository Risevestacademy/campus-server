import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps } from '../maps/schema.js';
import { users } from '../users/schema.js';
import { DeskReleaseReason, deskClaims, desks } from './schema.js';

/**
 * Against a real engine (PGlite, committed migrations applied): the rules
 * about who holds a desk live in the migration.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite());

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

let deskId: string;
let otherDeskId: string;
let ada: string;
let grace: string;
let cohortA: string;
let cohortB: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate desk_claims, desks, maps, cohort_members, cohorts, users cascade`,
  );
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  const [desk, otherDesk] = await db
    .insert(desks)
    .values([
      { mapId: map.id, key: 'desk_a' },
      { mapId: map.id, key: 'desk_b' },
    ])
    .returning();
  const [first, second] = await db
    .insert(users)
    .values([{ email: 'ada@campus.local' }, { email: 'grace@campus.local' }])
    .returning();
  const [a, b] = await db
    .insert(cohorts)
    .values([
      { name: 'Cohort A', code: 'CA' },
      { name: 'Cohort B', code: 'CB' },
    ])
    .returning();
  await db.insert(cohortMembers).values(
    [a, b].flatMap((cohort) =>
      [first, second].map((user) => ({
        cohortId: cohort.id,
        userId: user.id,
        role: CohortRole.Mentor,
      })),
    ),
  );
  [deskId, otherDeskId] = [desk.id, otherDesk.id];
  [ada, grace, cohortA, cohortB] = [first.id, second.id, a.id, b.id];
});

const claim = (
  overrides: Partial<typeof deskClaims.$inferInsert> = {},
): Promise<unknown> =>
  db.insert(deskClaims).values({
    deskId,
    cohortId: cohortA,
    userId: ada,
    ...overrides,
  });

describe('desks', () => {
  it('knows a desk by its key across every map, retired or not', async () => {
    const [annex] = await db
      .insert(maps)
      .values({ key: 'annex', name: 'Annex' })
      .returning();
    await db
      .update(desks)
      .set({ retiredAt: new Date() })
      .where(sql`${desks.key} = 'desk_a'`);

    await expectViolation(
      db.insert(desks).values({ mapId: annex.id, key: 'desk_a' }),
      'desks_key_unique',
    );
  });
});

describe('desk_claims', () => {
  it('lets one person at a time hold a desk in a cohort', async () => {
    await claim();

    await expectViolation(claim({ userId: grace }), 'desk_claims_one_holder');
  });

  it('lets each cohort have its own holder for the same desk', async () => {
    await claim();

    await expect(
      claim({ userId: grace, cohortId: cohortB }),
    ).resolves.toBeDefined();
  });

  it('lets a person hold one desk in a cohort', async () => {
    await claim();

    await expectViolation(
      claim({ deskId: otherDeskId }),
      'desk_claims_one_desk',
    );
  });

  it('lets a person hold a desk in each of their cohorts', async () => {
    await claim();

    await expect(
      claim({ deskId: otherDeskId, cohortId: cohortB }),
    ).resolves.toBeDefined();
  });

  it('frees the desk, and the person, once the claim is released', async () => {
    await claim({
      claimedAt: new Date('2026-11-01T09:00:00Z'),
      releasedAt: new Date('2026-11-02T09:00:00Z'),
      releaseReason: DeskReleaseReason.Released,
    });

    await expect(claim({ userId: grace })).resolves.toBeDefined();
    await expect(claim({ deskId: otherDeskId })).resolves.toBeDefined();
  });

  it('gives a reason when, and only when, a claim is released', async () => {
    await expectViolation(
      claim({
        claimedAt: new Date('2026-11-01T09:00:00Z'),
        releasedAt: new Date('2026-11-02T09:00:00Z'),
      }),
      'desk_claims_release_reason',
    );
    await expectViolation(
      claim({ releaseReason: DeskReleaseReason.FreedByAdmin }),
      'desk_claims_release_reason',
    );
  });

  it('is not released before it was claimed', async () => {
    await expectViolation(
      claim({
        claimedAt: new Date('2026-11-02T10:00:00Z'),
        releasedAt: new Date('2026-11-02T09:00:00Z'),
        releaseReason: DeskReleaseReason.Released,
      }),
      'desk_claims_release_window',
    );
  });
});
