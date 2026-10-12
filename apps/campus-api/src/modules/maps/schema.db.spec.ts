import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { cohortTracks, cohorts } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import {
  AudioMode,
  OutsiderVisibility,
  PublishPolicy,
  SpaceAccess,
  SpaceKind,
  maps,
  spaceMemberships,
  spaces,
} from './schema.js';

/**
 * The rules about maps and spaces live in the migration, so they are tested
 * there: against a real PostgreSQL engine (PGlite, in-process) with the
 * committed migrations applied. A rule that only a schema file states
 * protects nothing.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), {
  schema: { users, tracks, cohorts, cohortTracks, maps, spaces },
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

let mapId: string;
let userId: string;
let cohortTrackId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate space_memberships, spaces, maps, cohort_tracks, cohorts, tracks, users cascade`,
  );
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ email: 'ada@campus.local' })
    .returning();
  const [track] = await db
    .insert(tracks)
    .values({ name: 'Software Engineering', code: 'SE' })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'Cohort 1', code: 'C1' })
    .returning();
  const [cohortTrack] = await db
    .insert(cohortTracks)
    .values({ cohortId: cohort.id, trackId: track.id })
    .returning();
  [mapId, userId, cohortTrackId] = [map.id, user.id, cohortTrack.id];
});

function space(overrides: Partial<typeof spaces.$inferInsert> = {}) {
  return db
    .insert(spaces)
    .values({
      mapId,
      key: 'library',
      name: 'Library',
      kind: SpaceKind.Open,
      audioMode: AudioMode.Proximity,
      access: SpaceAccess.Open,
      ...overrides,
    })
    .returning();
}

describe('maps', () => {
  it('knows a map by its key, once', async () => {
    await expectViolation(
      db.insert(maps).values({ key: 'campus', name: 'Campus again' }),
      'maps_key_unique',
    );
  });

  it('has one way into the campus', async () => {
    await db.insert(maps).values({ key: 'library', name: 'Library' });

    await expectViolation(
      db.insert(maps).values({ key: 'annex', name: 'Annex', isEntry: true }),
      'maps_single_entry',
    );
  });

  /** Replacing the entry map must not need the old one deleted. */
  it('lets another map be the entry once the old one is retired', async () => {
    await db
      .update(maps)
      .set({ retiredAt: new Date() })
      .where(sql`${maps.key} = 'campus'`);

    await expect(
      db.insert(maps).values({ key: 'annex', name: 'Annex', isEntry: true }),
    ).resolves.toBeDefined();
  });
});

describe('spaces', () => {
  it('starts a space on the settings nobody has to choose', async () => {
    const [row] = await space();

    expect(row).toMatchObject({
      isMapDefault: false,
      outsiderVisibility: OutsiderVisibility.AvatarsVisible,
      publishPolicy: PublishPolicy.All,
      capacity: null,
      hysteresisFactor: '1.20',
      retiredAt: null,
    });
  });

  /** Not set up yet: the map drew it, and no admin has said what it is. */
  it('keeps a space that has no kind', async () => {
    const [row] = await space({ kind: null });

    expect(row.kind).toBeNull();
  });

  it('knows a space by its key, once per map', async () => {
    await space();
    await expectViolation(
      space({ name: 'Library two' }),
      'spaces_map_key_unique',
    );

    const [other] = await db
      .insert(maps)
      .values({ key: 'annex', name: 'Annex' })
      .returning();
    await expect(space({ mapId: other.id })).resolves.toBeDefined();
  });

  /** A key that comes back is the same space coming back. */
  it('keeps a retired space its key', async () => {
    await space({ retiredAt: new Date() });

    await expectViolation(space(), 'spaces_map_key_unique');
  });

  it('gives a map at most one default space, and each map its own', async () => {
    await space({ key: 'grounds', isMapDefault: true });
    await expectViolation(
      space({ key: 'more-grounds', isMapDefault: true }),
      'spaces_one_default_per_map',
    );

    const [other] = await db
      .insert(maps)
      .values({ key: 'annex', name: 'Annex' })
      .returning();
    await expect(
      space({ mapId: other.id, key: 'grounds', isMapDefault: true }),
    ).resolves.toBeDefined();
  });

  /**
   * At most one is all the database can say. Seeing that a map has its
   * default is for whatever writes the map's rows.
   */
  it('does not itself give a map a default space', async () => {
    await space();

    const defaults = await db
      .select()
      .from(spaces)
      .where(sql`${spaces.mapId} = ${mapId} and ${spaces.isMapDefault}`);
    expect(defaults).toEqual([]);
  });

  /** It keeps one key for good, and comes back as the same row. */
  it('keeps a retired default space the place of its map', async () => {
    await space({ key: 'grounds', isMapDefault: true, retiredAt: new Date() });

    await expectViolation(
      space({ key: 'new-grounds', isMapDefault: true }),
      'spaces_one_default_per_map',
    );
  });

  /** It is the way to everywhere else; gating it shuts people out of that. */
  it('refuses a default space that is not open to everybody', async () => {
    await expectViolation(
      space({ isMapDefault: true, access: SpaceAccess.Cohort }),
      'spaces_default_is_open',
    );
  });

  it('refuses a broadcast everybody may speak in', async () => {
    await expectViolation(
      space({ audioMode: AudioMode.Broadcast }),
      'spaces_broadcast_restricts_publish',
    );
    await expect(
      space({
        audioMode: AudioMode.Broadcast,
        publishPolicy: PublishPolicy.Staff,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a capacity nobody fits in', async () => {
    await expectViolation(space({ capacity: 0 }), 'spaces_capacity_positive');
    await expect(space({ capacity: 1 })).resolves.toBeDefined();
  });

  it.each([
    [SpaceKind.TownHall, 'spaces_single_town_hall'],
    [SpaceKind.NoticeBoard, 'spaces_single_notice_board'],
  ])('has one %s on the whole campus, on whichever map', async (kind, rule) => {
    const [other] = await db
      .insert(maps)
      .values({ key: 'annex', name: 'Annex' })
      .returning();
    const [first] = await space({ key: 'first', kind });

    await expectViolation(
      space({ mapId: other.id, key: 'second', kind }),
      rule,
    );

    // Retiring the first leaves room for another.
    await db
      .update(spaces)
      .set({ retiredAt: new Date() })
      .where(sql`${spaces.id} = ${first.id}`);
    await expect(
      space({ mapId: other.id, key: 'second', kind }),
    ).resolves.toBeDefined();
  });

  it('may hold any number of the other kinds', async () => {
    await space({ key: 'room-1', kind: SpaceKind.MeetingRoom });

    await expect(
      space({ key: 'room-2', kind: SpaceKind.MeetingRoom }),
    ).resolves.toBeDefined();
  });

  it('belongs to a map that exists', async () => {
    await expectViolation(
      space({ mapId: '00000000-0000-4000-8000-000000000000' }),
      'spaces_map_id_maps_id_fk',
    );
  });
});

describe('space_memberships', () => {
  let spaceId: string;

  beforeEach(async () => {
    [{ id: spaceId }] = await space({ access: SpaceAccess.Invite });
  });

  const grant = (
    overrides: Partial<typeof spaceMemberships.$inferInsert> = {},
  ) => db.insert(spaceMemberships).values({ spaceId, ...overrides });

  it('grants a space to one person, or to one track', async () => {
    await expect(grant({ userId })).resolves.toBeDefined();
    await expect(grant({ cohortTrackId })).resolves.toBeDefined();
  });

  /** With both, whose access ends when one of them does? With neither, nobody's. */
  it('refuses a grant to both, and a grant to neither', async () => {
    await expectViolation(
      grant({ userId, cohortTrackId }),
      'space_memberships_one_subject',
    );
    await expectViolation(grant(), 'space_memberships_one_subject');
  });

  it('refuses a grant that ends before it starts', async () => {
    const from = new Date('2026-10-10T09:00:00Z');

    await expectViolation(
      grant({ userId, validFrom: from, validTo: from }),
      'space_memberships_valid_window',
    );
    await expect(
      grant({
        userId,
        validFrom: from,
        validTo: new Date('2026-10-10T09:00:01Z'),
      }),
    ).resolves.toBeDefined();
  });

  it('points at a space, a person and a track that exist', async () => {
    const nobody = '00000000-0000-4000-8000-000000000000';

    await expectViolation(
      db.insert(spaceMemberships).values({ spaceId: nobody, userId }),
      'space_memberships_space_id_spaces_id_fk',
    );
    await expectViolation(
      grant({ userId: nobody }),
      'space_memberships_user_id_users_id_fk',
    );
    await expectViolation(
      grant({ cohortTrackId: nobody }),
      'space_memberships_cohort_track_id_cohort_tracks_id_fk',
    );
    await expectViolation(
      grant({ userId, grantedBy: nobody }),
      'space_memberships_granted_by_users_id_fk',
    );
  });
});
