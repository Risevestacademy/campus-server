import { PGlite } from '@electric-sql/pglite';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { MapSyncOutcome } from './dto/map-sync.dto.js';
import { MapSyncService } from './map-sync.service.js';
import { PublishedMapsRejectedException } from './maps.exceptions.js';
import type {
  PublishedMap,
  PublishedMapsReader,
  PublishedSpace,
} from './published-maps.js';
import {
  AudioMode,
  PublishPolicy,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from './schema.js';
import { DEFAULT_SPACE_KEY } from './space-defaults.js';

/**
 * Against a real engine (PGlite, committed migrations applied). What a sync
 * may and may not change is settled by rows and constraints, and a mocked
 * query builder would only prove they were called.
 *
 * What is published is handed in directly: reading it from Sanity is the
 * reader's job, and has its own tests.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), { schema: { users, maps, spaces, auditLog } });

let published: PublishedMap[] = [];
const reader = {
  read: vi.fn(async () => published),
} as unknown as PublishedMapsReader;
const service = new MapSyncService(db as never, reader);

let admin: AuthenticatedUser;

const space = (
  key: string,
  tiledClass: string | null = null,
  name = key,
): PublishedSpace => ({ key, name, tiledClass });

const map = (
  key: string,
  drawn: PublishedSpace[] = [],
  overrides: Partial<PublishedMap> = {},
): PublishedMap => ({
  key,
  version: `${key}-v1`,
  isEntry: key === 'campus',
  spaces: drawn,
  ...overrides,
});

/** Publishes, and syncs. */
const sync = (maps_: PublishedMap[], dryRun = false) => {
  published = maps_;
  return service.sync(admin, { dryRun, correlationId: 'corr-1' });
};

const mapRows = () =>
  db
    .select({ key: maps.key, isEntry: maps.isEntry, retiredAt: maps.retiredAt })
    .from(maps)
    .orderBy(asc(maps.key));

/** A map's spaces, as `key[kind]`, with a `†` on a retired one. */
const spacesOf = async (mapKey: string) =>
  (
    await db
      .select({ key: spaces.key, kind: spaces.kind, retired: spaces.retiredAt })
      .from(spaces)
      .innerJoin(maps, eq(maps.id, spaces.mapId))
      .where(eq(maps.key, mapKey))
      .orderBy(asc(spaces.key))
  ).map((row) => `${row.key}[${row.kind ?? ''}]${row.retired ? '†' : ''}`);

const spaceRow = async (mapKey: string, key: string) => {
  const [row] = await db
    .select({ space: spaces })
    .from(spaces)
    .innerJoin(maps, eq(maps.id, spaces.mapId))
    .where(sql`${maps.key} = ${mapKey} and ${spaces.key} = ${key}`);
  return row.space;
};

const entries = () =>
  db
    .select({
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      subjectType: auditLog.subjectType,
      details: auditLog.details,
      correlationId: auditLog.correlationId,
    })
    .from(auditLog)
    .orderBy(auditLog.createdAt, auditLog.id);

const snapshot = async () => ({
  maps: await db.select().from(maps).orderBy(asc(maps.key)),
  spaces: await db.select().from(spaces).orderBy(asc(spaces.id)),
});

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate audit_log, spaces, maps, users cascade`);
  const [row] = await db
    .insert(users)
    .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
    .returning();
  admin = { id: row.id, email: row.email, systemRole: row.systemRole };
});

describe('a first sync', () => {
  it('gives the map a row, its default space, and a row for each space drawn', async () => {
    const result = await sync([
      map('campus', [
        space('library', 'open', 'The Library'),
        space('room_1', 'meeting_room'),
      ]),
    ]);

    expect(result).toEqual({
      dryRun: false,
      changed: true,
      maps: [
        {
          key: 'campus',
          version: 'campus-v1',
          isEntry: true,
          outcome: MapSyncOutcome.Created,
          spaces: {
            added: [
              { key: 'library', name: 'The Library', kind: SpaceKind.Open },
              { key: 'room_1', name: 'room_1', kind: SpaceKind.MeetingRoom },
            ],
            restored: [],
            retired: [],
            needsKind: [],
          },
        },
      ],
    });
    await expect(mapRows()).resolves.toEqual([
      { key: 'campus', isEntry: true, retiredAt: null },
    ]);
    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'library[open]',
      'room_1[meeting_room]',
    ]);
  });

  /** The map carries no name of its own; its ID stands in until one is given. */
  it('names the map by its key, and each space as the map names it', async () => {
    await sync([map('campus', [space('library', 'open', 'The Library')])]);

    const [row] = await db.select({ name: maps.name }).from(maps);
    expect(row.name).toBe('campus');
    await expect(spaceRow('campus', 'library')).resolves.toMatchObject({
      name: 'The Library',
    });
  });

  it('starts each space on the settings its kind starts with', async () => {
    await sync([
      map('campus', [
        space('library', 'open'),
        space('room_1', 'meeting_room'),
        space('se', 'classroom'),
        space('hall', 'town_hall'),
      ]),
    ]);

    await expect(spaceRow('campus', 'library')).resolves.toMatchObject({
      audioMode: AudioMode.Proximity,
      access: SpaceAccess.Open,
      publishPolicy: PublishPolicy.All,
    });
    await expect(spaceRow('campus', 'room_1')).resolves.toMatchObject({
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Open,
    });
    await expect(spaceRow('campus', 'se')).resolves.toMatchObject({
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Cohort,
    });
    // A broadcast where everybody may speak is not one, and the database
    // refuses it: the town hall has to start with staff speaking.
    await expect(spaceRow('campus', 'hall')).resolves.toMatchObject({
      audioMode: AudioMode.Broadcast,
      access: SpaceAccess.Open,
      publishPolicy: PublishPolicy.Staff,
    });
  });

  it('gives every kind there is settings the database will take', async () => {
    const kinds = Object.values(SpaceKind);

    await sync([
      map(
        'campus',
        kinds.map((kind) => space(`a_${kind}`, kind)),
      ),
    ]);

    await expect(spacesOf('campus')).resolves.toHaveLength(kinds.length + 1);
  });

  it('writes one audit entry for the map, naming the version it read', async () => {
    await sync([map('campus', [space('library', 'open'), space('nook')])]);

    await expect(entries()).resolves.toEqual([
      {
        actorUserId: admin.id,
        action: AuditAction.MapSynced,
        subjectType: AuditSubjectType.Map,
        details: {
          key: 'campus',
          version: 'campus-v1',
          outcome: 'created',
          isEntry: true,
          spacesAdded: ['library', 'nook'],
          spacesRestored: [],
          spacesRetired: [],
        },
        correlationId: 'corr-1',
      },
    ]);
  });
});

/**
 * The class a designer gives a space in Tiled is a rough label: often
 * blank, sometimes misspelt, sometimes a word the campus has no rules for.
 */
describe('the kind a map suggests', () => {
  it.each([
    ['Meeting Room', SpaceKind.MeetingRoom],
    ['meeting-room', SpaceKind.MeetingRoom],
    ['  OPEN ', SpaceKind.Open],
    ['live coding', SpaceKind.LiveCoding],
  ])('reads "%s" as the kind it plainly means', async (tiledClass, kind) => {
    const result = await sync([map('campus', [space('a', tiledClass)])]);

    expect(result.maps[0].spaces.added[0].kind).toBe(kind);
  });

  it.each([[null], [''], ['lounge'], ['clasroom']])(
    'takes %j as no suggestion, and leaves the space not set up',
    async (tiledClass) => {
      const result = await sync([map('campus', [space('nook', tiledClass)])]);

      expect(result.maps[0].spaces.added).toEqual([
        { key: 'nook', name: 'nook', kind: null },
      ]);
      expect(result.maps[0].spaces.needsKind).toEqual(['nook']);
      // Closed as far as anything reading `access` alone can tell.
      await expect(spaceRow('campus', 'nook')).resolves.toMatchObject({
        kind: null,
        access: SpaceAccess.Invite,
      });
    },
  );

  /** The campus has one town hall. The database refuses a second. */
  it('gives the campus’s one town hall to the first space that asks, and no kind to the next', async () => {
    const result = await sync([
      map('campus', [
        space('hall_a', 'town_hall'),
        space('hall_b', 'town_hall'),
      ]),
      map('annex', [
        space('board', 'notice_board'),
        space('hall_c', 'town_hall'),
      ]),
    ]);

    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'hall_a[town_hall]',
      'hall_b[]',
    ]);
    await expect(spacesOf('annex')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'board[notice_board]',
      'hall_c[]',
    ]);
    const byKey = Object.fromEntries(result.maps.map((m) => [m.key, m]));
    expect(byKey.campus.spaces.needsKind).toEqual(['hall_b']);
    expect(byKey.annex.spaces.needsKind).toEqual(['hall_c']);
  });

  it('does not hand out a town hall when a space already is one', async () => {
    await sync([map('campus', [space('hall', 'town_hall')])]);

    await sync([
      map('campus', [space('hall', 'town_hall'), space('forum', 'town_hall')]),
    ]);

    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'forum[]',
      'hall[town_hall]',
    ]);
  });

  /**
   * Renamed in Tiled, a town hall is one space going and another arriving
   * in the same publish. The old one has to be out of the way first.
   */
  it('lets the town hall move to a new space in one sync', async () => {
    await sync([map('campus', [space('hall', 'town_hall')])]);

    await sync([map('campus', [space('forum', 'town_hall')])]);

    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'forum[town_hall]',
      'hall[town_hall]†',
    ]);
  });
});

describe('syncing again', () => {
  const first = [
    map('campus', [space('library', 'open'), space('room_1', 'meeting_room')]),
  ];

  it('changes nothing, and records nothing, when nothing was published since', async () => {
    await sync(first);
    const before = await snapshot();

    const result = await sync(first);

    expect(result).toMatchObject({
      changed: false,
      maps: [
        {
          key: 'campus',
          outcome: MapSyncOutcome.Unchanged,
          spaces: { added: [], restored: [], retired: [], needsKind: [] },
        },
      ],
    });
    await expect(snapshot()).resolves.toEqual(before);
    await expect(entries()).resolves.toHaveLength(1);
  });

  /** A new version of the same map, with the same spaces, changes no row. */
  it('reports the version it read, and that nothing changed, for a new version with the same spaces', async () => {
    await sync(first);

    const result = await sync([{ ...first[0], version: 'campus-v2' }]);

    expect(result).toMatchObject({
      changed: false,
      maps: [{ version: 'campus-v2', outcome: MapSyncOutcome.Unchanged }],
    });
  });

  /**
   * What an admin sets is theirs. The map may go on suggesting something
   * else for as long as it likes.
   */
  it('never overwrites a name, a kind or a setting', async () => {
    await sync(first);
    await db.update(maps).set({ name: 'Rise Campus' });
    const { id } = await spaceRow('campus', 'library');
    await db
      .update(spaces)
      .set({
        name: 'Reading Room',
        kind: SpaceKind.Classroom,
        access: SpaceAccess.Invite,
        audioMode: AudioMode.Boundary,
        capacity: 12,
      })
      .where(eq(spaces.id, id));

    const result = await sync([
      map('campus', [
        space('library', 'meeting_room', 'Library, renamed in Tiled'),
        space('room_1', 'meeting_room'),
      ]),
    ]);

    expect(result.changed).toBe(false);
    await expect(spaceRow('campus', 'library')).resolves.toMatchObject({
      name: 'Reading Room',
      kind: SpaceKind.Classroom,
      access: SpaceAccess.Invite,
      audioMode: AudioMode.Boundary,
      capacity: 12,
    });
    const [row] = await db.select({ name: maps.name }).from(maps);
    expect(row.name).toBe('Rise Campus');
  });

  it('adds a space drawn since, and lists the ones still waiting for a kind', async () => {
    await sync([map('campus', [space('library', 'open'), space('nook')])]);

    const result = await sync([
      map('campus', [space('library', 'open'), space('nook'), space('lab')]),
    ]);

    expect(result.maps[0]).toMatchObject({
      outcome: MapSyncOutcome.Updated,
      spaces: {
        added: [{ key: 'lab', name: 'lab', kind: null }],
        // `nook` was added last time and is still not set up.
        needsKind: ['lab', 'nook'],
      },
    });
  });

  it('retires a space no longer drawn, and keeps its row', async () => {
    await sync(first);
    const before = await spaceRow('campus', 'room_1');

    const result = await sync([map('campus', [space('library', 'open')])]);

    expect(result.maps[0]).toMatchObject({
      outcome: MapSyncOutcome.Updated,
      spaces: { added: [], restored: [], retired: ['room_1'] },
    });
    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'library[open]',
      'room_1[meeting_room]†',
    ]);
    await expect(spaceRow('campus', 'room_1')).resolves.toMatchObject({
      id: before.id,
    });
  });

  /** A key that comes back is the same space coming back. */
  it('brings a retired space back as the same row, with what it had', async () => {
    await sync(first);
    const { id } = await spaceRow('campus', 'room_1');
    await db
      .update(spaces)
      .set({ name: 'Board Room', access: SpaceAccess.Invite, capacity: 8 })
      .where(eq(spaces.id, id));
    await sync([map('campus', [space('library', 'open')])]);

    const result = await sync(first);

    expect(result.maps[0]).toMatchObject({
      outcome: MapSyncOutcome.Updated,
      spaces: { added: [], restored: ['room_1'], retired: [] },
    });
    await expect(spaceRow('campus', 'room_1')).resolves.toMatchObject({
      id,
      retiredAt: null,
      name: 'Board Room',
      kind: SpaceKind.MeetingRoom,
      access: SpaceAccess.Invite,
      capacity: 8,
    });
  });

  /**
   * It was the town hall when it was retired, and another space has been
   * made the town hall since. Bringing it back would mean a second town hall,
   * which the database refuses, or wiping the kind it was given, which the
   * sync never does. So the sync is refused, saying which two, and nothing
   * changes: the stored kind is still there for whichever stays published.
   */
  it('refuses to bring a town hall back while another space is the town hall', async () => {
    await sync([map('campus', [space('hall', 'town_hall')])]);
    await sync([map('campus', [space('forum', 'town_hall')])]);
    const before = await snapshot();

    await expect(
      sync([
        map('campus', [
          space('forum', 'town_hall'),
          space('hall', 'town_hall'),
        ]),
      ]),
    ).rejects.toMatchObject({
      constructor: PublishedMapsRejectedException,
      details: {
        problems: [
          'Space "hall" on "campus" is published again and was the campus\'s town hall, but "forum" on "campus" is the town hall now. Unpublish one of them.',
        ],
      },
    });

    await expect(snapshot()).resolves.toEqual(before);
    expect((await spaceRow('campus', 'hall')).kind).toBe(SpaceKind.TownHall);
  });

  /** A dry run answers what the sync would, and the sync would refuse. */
  it('refuses the same way in a dry run', async () => {
    await sync([map('campus', [space('hall', 'town_hall')])]);
    await sync([map('campus', [space('forum', 'town_hall')])]);

    await expect(
      sync(
        [
          map('campus', [
            space('forum', 'town_hall'),
            space('hall', 'town_hall'),
          ]),
        ],
        true,
      ),
    ).rejects.toBeInstanceOf(PublishedMapsRejectedException);
  });

  it('lists every such conflict, the notice board as well as the town hall', async () => {
    await sync([
      map('campus', [
        space('hall', 'town_hall'),
        space('board', 'notice_board'),
      ]),
    ]);
    await sync([
      map('campus', [
        space('forum', 'town_hall'),
        space('wall', 'notice_board'),
      ]),
    ]);

    await expect(
      sync([
        map('campus', [
          space('forum', 'town_hall'),
          space('wall', 'notice_board'),
          space('hall', 'town_hall'),
          space('board', 'notice_board'),
        ]),
      ]),
    ).rejects.toMatchObject({
      details: {
        // By space key, whatever order the map lists them in.
        problems: [
          expect.stringContaining('"board" on "campus"'),
          expect.stringContaining('"hall" on "campus"'),
        ],
      },
    });
  });

  /**
   * A town hall coming back and a new space the map suggests as one, in the
   * same publish. The one that already was the town hall keeps it, whichever
   * the map lists first; the new one is left for an admin.
   */
  it.each([
    ['the returning space first', ['hall', 'forum']],
    ['the new space first', ['forum', 'hall']],
  ])(
    'gives the town hall back to the space that had it, with %s',
    async (_, order) => {
      await sync([map('campus', [space('hall', 'town_hall')])]);
      await sync([map('campus')]);

      const result = await sync([
        map(
          'campus',
          order.map((key) => space(key, 'town_hall')),
        ),
      ]);

      expect(result.maps[0].spaces).toMatchObject({
        added: [{ key: 'forum', kind: null }],
        restored: ['hall'],
        needsKind: ['forum'],
      });
      await expect(spacesOf('campus')).resolves.toEqual([
        `${DEFAULT_SPACE_KEY}[open]`,
        'forum[]',
        'hall[town_hall]',
      ]);
    },
  );

  /** Two returning spaces that were each a town hall: decided by key, not by order. */
  it('refuses the same way whichever of two returning town halls the map lists first', async () => {
    await sync([map('campus', [space('alpha', 'town_hall')])]);
    await sync([map('campus')]);
    await sync([map('annex'), map('campus')]);
    await sync([map('annex', [space('beta', 'town_hall')]), map('campus')]);
    await sync([map('annex'), map('campus')]);

    const answers = [];
    for (const maps of [
      [
        map('annex', [space('beta', 'town_hall')]),
        map('campus', [space('alpha', 'town_hall')]),
      ],
      [
        map('campus', [space('alpha', 'town_hall')]),
        map('annex', [space('beta', 'town_hall')]),
      ],
    ]) {
      answers.push(
        await sync(maps).then(
          () => 'synced',
          (err: { details?: { problems?: string[] } }) => err.details?.problems,
        ),
      );
    }

    expect(answers[0]).toEqual([
      expect.stringMatching(
        /^Space "alpha" on "campus" .* but "beta" on "annex"/,
      ),
    ]);
    expect(answers[1]).toEqual(answers[0]);
  });

  /** With nobody else holding it, a town hall comes back as one. */
  it('brings a town hall back as the town hall when the campus has none', async () => {
    await sync([map('campus', [space('hall', 'town_hall')])]);
    await sync([map('campus')]);

    const result = await sync([map('campus', [space('hall', 'town_hall')])]);

    expect(result.maps[0].spaces).toMatchObject({
      restored: ['hall'],
      needsKind: [],
    });
    expect((await spaceRow('campus', 'hall')).kind).toBe(SpaceKind.TownHall);
  });

  it('writes an entry for what changed, and only for the map it changed on', async () => {
    await sync([...first, map('annex', [space('lab', 'classroom')])]);
    await db.execute(sql`truncate audit_log`);

    await sync([
      map('campus', [space('library', 'open'), space('cafe', 'open')]),
      map('annex', [space('lab', 'classroom')]),
    ]);

    await expect(entries()).resolves.toEqual([
      expect.objectContaining({
        action: AuditAction.MapSynced,
        details: {
          key: 'campus',
          version: 'campus-v1',
          outcome: 'updated',
          isEntry: true,
          spacesAdded: ['cafe'],
          spacesRestored: [],
          spacesRetired: ['room_1'],
        },
      }),
    ]);
  });
});

/**
 * The designer draws the rooms. Everything else on a map is in the default
 * space, which is drawn nowhere. The database stops a map having two; this
 * is what makes sure it has one.
 */
describe('the default space', () => {
  it('is given to every map, open to everybody, exactly once', async () => {
    await sync([map('campus'), map('annex')]);
    await sync([map('campus'), map('annex')]);

    for (const key of ['campus', 'annex']) {
      await expect(spacesOf(key)).resolves.toEqual([
        `${DEFAULT_SPACE_KEY}[open]`,
      ]);
      await expect(spaceRow(key, DEFAULT_SPACE_KEY)).resolves.toMatchObject({
        isMapDefault: true,
        kind: SpaceKind.Open,
        access: SpaceAccess.Open,
        audioMode: AudioMode.Proximity,
        retiredAt: null,
      });
    }
  });

  /** It is never drawn, so not being drawn must never retire it. */
  it('is not retired for not being on the map, and is never one that needs a kind', async () => {
    await sync([map('campus', [space('library', 'open')])]);

    const result = await sync([map('campus')]);

    expect(result.maps[0].spaces).toEqual({
      added: [],
      restored: [],
      retired: ['library'],
      needsKind: [],
    });
    await expect(spaceRow('campus', DEFAULT_SPACE_KEY)).resolves.toMatchObject({
      retiredAt: null,
    });
  });

  it('is given back to a map that has somehow lost it', async () => {
    await sync([map('campus')]);
    await db.delete(spaces);

    const result = await sync([map('campus')]);

    expect(result).toMatchObject({
      changed: true,
      maps: [{ outcome: MapSyncOutcome.Updated }],
    });
    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
    ]);
  });

  /** Nothing here retires it alone, but a row edited by hand could be. */
  it('is brought back when it was retired on a map that was not', async () => {
    await sync([map('campus')]);
    await db.update(spaces).set({ retiredAt: new Date() });

    const result = await sync([map('campus')]);

    expect(result).toMatchObject({
      changed: true,
      maps: [{ outcome: MapSyncOutcome.Updated }],
    });
    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
    ]);
    await expect(entries()).resolves.toHaveLength(2);
  });

  it('keeps what an admin has made of it', async () => {
    await sync([map('campus')]);
    await db.update(spaces).set({ name: 'The Grounds', capacity: 500 });

    await sync([map('campus')]);

    await expect(spaceRow('campus', DEFAULT_SPACE_KEY)).resolves.toMatchObject({
      name: 'The Grounds',
      capacity: 500,
    });
  });
});

describe('a map no longer published', () => {
  const both = [
    map('campus', [space('library', 'open')]),
    map('annex', [space('lab', 'classroom'), space('den')]),
  ];

  it('is retired with every space on it, its default included, and keeps its rows', async () => {
    await sync(both);

    const result = await sync([both[0]]);

    expect(result.maps).toEqual([
      {
        key: 'annex',
        version: null,
        isEntry: false,
        outcome: MapSyncOutcome.Retired,
        spaces: {
          added: [],
          restored: [],
          retired: ['den', 'lab'],
          needsKind: [],
        },
      },
      expect.objectContaining({
        key: 'campus',
        outcome: MapSyncOutcome.Unchanged,
      }),
    ]);
    await expect(mapRows()).resolves.toEqual([
      { key: 'annex', isEntry: false, retiredAt: expect.any(Date) },
      { key: 'campus', isEntry: true, retiredAt: null },
    ]);
    await expect(spacesOf('annex')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]†`,
      'den[]†',
      'lab[classroom]†',
    ]);
  });

  it('is recorded as retired, once, and not again on the next sync', async () => {
    await sync(both);
    await db.execute(sql`truncate audit_log`);

    await sync([both[0]]);
    const again = await sync([both[0]]);

    expect(again.changed).toBe(false);
    // Still gone, and already retired: there is nothing left to say of it.
    expect(again.maps.map((m) => m.key)).toEqual(['campus']);
    await expect(entries()).resolves.toEqual([
      expect.objectContaining({
        action: AuditAction.MapRetired,
        subjectType: AuditSubjectType.Map,
        details: { key: 'annex', spacesRetired: ['den', 'lab'] },
      }),
    ]);
  });

  it('comes back as the same row, with its spaces and its default', async () => {
    await sync(both);
    const [annex] = await db
      .select({ id: maps.id })
      .from(maps)
      .where(eq(maps.key, 'annex'));
    await sync([both[0]]);

    const result = await sync(both);

    expect(result.maps[0]).toMatchObject({
      key: 'annex',
      outcome: MapSyncOutcome.Restored,
      spaces: { added: [], restored: ['lab', 'den'], needsKind: ['den'] },
    });
    await expect(
      db.select({ id: maps.id }).from(maps).where(eq(maps.key, 'annex')),
    ).resolves.toEqual([annex]);
    await expect(spacesOf('annex')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'den[]',
      'lab[classroom]',
    ]);
  });

  /** The campus keeps one town hall even when the map it was on goes. */
  it('frees the town hall it held for a space on another map', async () => {
    await sync([map('campus'), map('annex', [space('hall', 'town_hall')])]);

    await sync([map('campus', [space('forum', 'town_hall')])]);

    await expect(spacesOf('campus')).resolves.toEqual([
      `${DEFAULT_SPACE_KEY}[open]`,
      'forum[town_hall]',
    ]);
  });
});

describe('the entry map', () => {
  /**
   * The database holds the campus to at most one entry map; the sync is what
   * makes it exactly one. After any sync that is let through, there is one
   * live entry map, the one published as it, whatever there was before.
   */
  it('leaves exactly one live entry map after every sync', async () => {
    const liveEntries = async () =>
      (await mapRows())
        .filter((row) => row.isEntry && row.retiredAt === null)
        .map((row) => row.key);

    for (const published of [
      [map('campus')],
      [
        map('campus', [], { isEntry: false }),
        map('annex', [], { isEntry: true }),
      ],
      [map('plaza', [], { isEntry: true })],
      [
        map('campus', [], { isEntry: true }),
        map('plaza', [], { isEntry: false }),
      ],
    ]) {
      await sync(published);
      await expect(liveEntries()).resolves.toEqual([
        published.find((one) => one.isEntry)!.key,
      ]);
    }
  });

  /** The database allows one at a time, so the old one lets go first. */
  it('moves from one map to another in a single sync', async () => {
    await sync([map('campus'), map('annex')]);

    const result = await sync([
      map('campus', [], { isEntry: false }),
      map('annex', [], { isEntry: true }),
    ]);

    expect(result.maps).toEqual([
      expect.objectContaining({
        key: 'annex',
        isEntry: true,
        outcome: MapSyncOutcome.Updated,
      }),
      expect.objectContaining({
        key: 'campus',
        isEntry: false,
        outcome: MapSyncOutcome.Updated,
      }),
    ]);
    await expect(mapRows()).resolves.toEqual([
      { key: 'annex', isEntry: true, retiredAt: null },
      { key: 'campus', isEntry: false, retiredAt: null },
    ]);
  });

  /**
   * The order Sanity lists them in is not this service's to choose. Here the
   * map taking the flag comes before the one giving it up, so the flag has
   * to be off the old map before the new map's row is touched at all.
   */
  it('moves whichever of the two maps is listed first', async () => {
    await sync([map('campus'), map('annex')]);

    await sync([
      map('annex', [], { isEntry: true }),
      map('campus', [], { isEntry: false }),
    ]);

    await expect(mapRows()).resolves.toEqual([
      { key: 'annex', isEntry: true, retiredAt: null },
      { key: 'campus', isEntry: false, retiredAt: null },
    ]);
  });

  it('passes to a new map when the old entry map is no longer published', async () => {
    await sync([map('campus')]);

    await sync([map('plaza', [], { isEntry: true })]);

    await expect(mapRows()).resolves.toEqual([
      { key: 'campus', isEntry: false, retiredAt: expect.any(Date) },
      { key: 'plaza', isEntry: true, retiredAt: null },
    ]);
  });
});

describe('a dry run', () => {
  const first = [map('campus', [space('library', 'open'), space('nook')])];

  it('answers exactly what a sync would, and keeps none of it', async () => {
    const preview = await sync(first, true);

    await expect(snapshot()).resolves.toEqual({ maps: [], spaces: [] });
    await expect(entries()).resolves.toEqual([]);

    const real = await sync(first);
    expect(preview).toEqual({ ...real, dryRun: true });
    expect(real.dryRun).toBe(false);
  });

  it('shows what a later sync would retire and add, and leaves the rows as they are', async () => {
    await sync(first);
    const before = await snapshot();

    const preview = await sync(
      [map('campus', [space('nook'), space('lab')])],
      true,
    );

    expect(preview).toMatchObject({
      dryRun: true,
      changed: true,
      maps: [
        {
          outcome: MapSyncOutcome.Updated,
          spaces: {
            added: [{ key: 'lab', kind: null }],
            retired: ['library'],
            needsKind: ['lab', 'nook'],
          },
        },
      ],
    });
    await expect(snapshot()).resolves.toEqual(before);
    await expect(entries()).resolves.toHaveLength(1);
  });
});

/**
 * The published maps are read whole before anything is written. If they
 * cannot be adopted, the database is not touched.
 */
describe('when what is published cannot be adopted', () => {
  it('changes nothing, and lets the reader’s refusal through', async () => {
    await sync([map('campus', [space('library', 'open')])]);
    const before = await snapshot();
    vi.mocked(reader.read).mockRejectedValueOnce(
      new PublishedMapsRejectedException('cannot be adopted', ['a problem']),
    );

    await expect(
      service.sync(admin, { correlationId: 'corr-2' }),
    ).rejects.toBeInstanceOf(PublishedMapsRejectedException);

    await expect(snapshot()).resolves.toEqual(before);
    await expect(entries()).resolves.toHaveLength(1);
  });
});
