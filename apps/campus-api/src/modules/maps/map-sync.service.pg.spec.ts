import { asc, eq, inArray, sql } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { SystemRole, users } from '../users/schema.js';
import { MapSyncService } from './map-sync.service.js';
import { MapSyncBusyException } from './maps.exceptions.js';
import type { PublishedMap, PublishedMapsReader } from './published-maps.js';
import { maps, spaces } from './schema.js';

/**
 * What the sync's lock is for. A sync reads every published map and then
 * writes the rows to match. Two at once, each reading before it waited its
 * turn, could leave the older read written last: the database a publish
 * behind. So a sync takes the lock first, without waiting, and reads only
 * once it holds it; a second sync meanwhile is told one is running.
 *
 * Made deterministic rather than raced: the first sync's read is held open
 * until the test lets it go, so the second always arrives while the first
 * holds the lock. A third connection looks at the lock from outside.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)('MapSyncService, two syncs at once', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let watcher: ReturnType<typeof connectRealPostgres>;
  let reader: { read: ReturnType<typeof vi.fn> };
  let service: MapSyncService;
  let admin: { id: string; email: string; systemRole: SystemRole };

  beforeAll(async () => {
    pg = connectRealPostgres();
    watcher = connectRealPostgres();
    reader = { read: vi.fn() };
    service = new MapSyncService(
      pg.db as never,
      reader as unknown as PublishedMapsReader,
    );
    const [row] = await pg.db
      .insert(users)
      .values({
        email: `maps-${unique()}@campus.local`,
        systemRole: SystemRole.Admin,
      })
      .returning();
    admin = { id: row.id, email: row.email, systemRole: row.systemRole };
  });

  afterAll(async () => {
    await pg.close();
    await watcher.close();
  });

  beforeEach(() => {
    reader.read.mockReset();
  });

  /** The campus as published, under keys no other test or run will use. */
  const campus = (key: string, spaceKeys: string[]): PublishedMap[] => [
    {
      key,
      version: `${key}-${spaceKeys.join('-')}`,
      isEntry: true,
      spaces: spaceKeys.map((spaceKey) => ({
        key: spaceKey,
        name: spaceKey,
        tiledClass: 'open',
      })),
    },
  ];

  /** Whether some connection holds the sync's lock right now. */
  const lockHeld = async (): Promise<boolean> => {
    const [row] = (await watcher.db.execute(sql`
      select exists (
        select 1
        from pg_locks, (select hashtextextended('maps:sync', 0) as key) lock
        where locktype = 'advisory'
          and granted
          and objsubid = 1
          and classid::bigint = (lock.key >> 32) & 4294967295
          and objid::bigint = lock.key & 4294967295
      ) as held
    `)) as unknown as { held: boolean }[];
    return row.held;
  };

  /** The live spaces on one map, by key. */
  const liveSpaces = async (mapKey: string) =>
    (
      await pg.db
        .select({ key: spaces.key })
        .from(spaces)
        .innerJoin(maps, eq(maps.id, spaces.mapId))
        .where(eq(maps.key, mapKey))
        .orderBy(asc(spaces.key))
    )
      .map((row) => row.key)
      .filter((key) => key !== '_default');

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  /** Settles to what `task` gave, or 'still waiting' after `ms`. */
  const within = <T>(task: Promise<T>, ms: number) =>
    Promise.race([
      task.then(
        (value) => ({ settled: 'resolved' as const, value }),
        (error: unknown) => ({ settled: 'rejected' as const, error }),
      ),
      new Promise<{ settled: 'still waiting' }>((done) =>
        setTimeout(() => done({ settled: 'still waiting' }), ms),
      ),
    ]);

  it('reads only with the lock held, and turns a second sync away at once', async () => {
    const key = `campus-${unique()}`;
    const gate = deferred();
    let heldWhenRead: boolean | undefined;
    reader.read.mockImplementationOnce(async () => {
      heldWhenRead = await lockHeld();
      await gate.promise;
      return campus(key, ['library']);
    });

    const first = service.sync(admin);
    await expect.poll(() => reader.read.mock.calls.length).toBe(1);

    const second = await within(service.sync(admin), 3_000);

    expect(second).toMatchObject({ settled: 'rejected' });
    expect((second as { error: unknown }).error).toBeInstanceOf(
      MapSyncBusyException,
    );
    // Turned away before reading anything: it had nothing to go stale.
    expect(reader.read).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(first).resolves.toMatchObject({ changed: true });
    expect(heldWhenRead).toBe(true);
    await expect(lockHeld()).resolves.toBe(false);
  }, 30_000);

  /**
   * A publish lands while the first sync is still reading the one before it.
   * The sync that overlapped it is refused rather than queued with a read in
   * hand, so once it is tried again it reads the newer publish, and that is
   * what the database ends up holding.
   */
  it('ends on the newer publish when a publish lands mid-sync', async () => {
    const key = `campus-${unique()}`;
    const gate = deferred();
    let published = campus(key, ['library']);
    reader.read.mockImplementation(async () => {
      const snapshot = published;
      if (reader.read.mock.calls.length === 1) await gate.promise;
      return snapshot;
    });

    const first = service.sync(admin);
    await expect.poll(() => reader.read.mock.calls.length).toBe(1);

    // The newer publish, and a sync started for it while the first runs.
    published = campus(key, ['library', 'lab']);
    const overlapping = await within(service.sync(admin), 3_000);
    expect(overlapping).toMatchObject({ settled: 'rejected' });

    gate.resolve();
    await first;
    await expect(liveSpaces(key)).resolves.toEqual(['library']);

    // Tried again, as the 409 tells the caller to.
    await service.sync(admin);
    await expect(liveSpaces(key)).resolves.toEqual(['lab', 'library']);

    // And nothing older lands afterwards.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(liveSpaces(key)).resolves.toEqual(['lab', 'library']);
    const [row] = await pg.db
      .select({ retiredAt: maps.retiredAt })
      .from(maps)
      .where(inArray(maps.key, [key]));
    expect(row.retiredAt).toBeNull();
  }, 30_000);
});
