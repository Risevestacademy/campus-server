import { DEFAULT_SPACE_KEY } from '@campus/session';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import {
  MapSyncOutcome,
  type MapSyncMapDto,
  type MapSyncResultDto,
} from './dto/map-sync.dto.js';
import {
  MapSyncBusyException,
  PublishedMapsRejectedException,
} from './maps.exceptions.js';
import { PublishedMapsReader, type PublishedMap } from './published-maps.js';
import { SpaceKind, maps, spaces, type Space } from './schema.js';
import {
  DEFAULT_SPACE_NAME,
  SINGLETON_KINDS,
  defaultsFor,
  suggestedKind,
} from './space-defaults.js';

type MapRow = typeof maps.$inferSelect;

/** Thrown to undo a dry run. Carries what the sync would have answered. */
class DryRun extends Error {
  constructor(readonly result: MapSyncResultDto) {
    super('dry run');
  }
}

/**
 * Brings what the database holds of the campus maps into line with what is
 * published.
 *
 * The published map says which maps and spaces exist. The database holds a
 * row for each, so that memberships, audit entries and, later, sessions have
 * something to point at, and so that the rules a drawing cannot hold have
 * somewhere to live. This is what creates those rows, and it is the only
 * thing that does.
 *
 * What it does, and what it leaves alone:
 *
 * - A map or space that is new gets a row. A space starts with the kind the
 *   map suggests, when it suggests one this knows, and the settings that
 *   kind starts with.
 * - A map or space that is no longer published is retired, never deleted.
 * - One that comes back is the same row, un-retired, with what it had.
 * - **Nothing an admin may have set is ever overwritten**: not a name, not
 *   a kind, not a setting. A sync only adds, retires and restores. Where
 *   restoring a space would cost it its kind, the sync is refused instead.
 * - Every map is given its default space, for the tiles inside no drawn
 *   one. The database stops a map having two; this is what makes sure it
 *   has one.
 *
 * All of it happens in one transaction or not at all, and only once the
 * published maps have been read whole and found fit to adopt. A sync that
 * finds nothing to change writes nothing, an audit entry included.
 */
@Injectable()
export class MapSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly published: PublishedMapsReader,
  ) {}

  async sync(
    admin: AuthenticatedUser,
    options: { dryRun?: boolean; correlationId?: string } = {},
    now: Date = new Date(),
  ): Promise<MapSyncResultDto> {
    const dryRun = options.dryRun ?? false;

    try {
      return await this.db.transaction(async (tx) => {
        // One sync at a time, and nobody waits for it. Read only once the
        // lock is held: a sync that read first and then waited could commit
        // a publish older than the one the sync before it had just written.
        // The cost is one connection held while Sanity answers, bounded by
        // the reader's timeout, on a route few call and fewer call at once.
        if (!(await tryLock(tx))) {
          throw new MapSyncBusyException(
            'Another sync of the maps is running. Try again once it is done.',
          );
        }
        const publishedMaps = await this.published.read();

        const result = await new Reconciliation(tx, now, publishedMaps).run();
        if (dryRun) {
          // Everything above really happened, inside this transaction, which
          // is what makes the answer exact. Throwing is what takes it back.
          throw new DryRun({ ...result, dryRun: true });
        }
        await this.record(tx, admin, options.correlationId, result.maps);
        return result;
      });
    } catch (err) {
      if (err instanceof DryRun) {
        return err.result;
      }
      throw err;
    }
  }

  /** One audit entry for each map the sync changed, and none for the rest. */
  private async record(
    tx: DbExecutor,
    admin: AuthenticatedUser,
    correlationId: string | undefined,
    changes: MapSyncMapDto[],
  ): Promise<void> {
    const rows = await tx.select({ id: maps.id, key: maps.key }).from(maps);
    const idOf = new Map(rows.map((row) => [row.key, row.id]));

    for (const map of changes) {
      const id = idOf.get(map.key);
      if (map.outcome === MapSyncOutcome.Unchanged || !id) {
        continue;
      }
      if (map.outcome === MapSyncOutcome.Retired) {
        await writeAuditEntry(tx, {
          actorUserId: admin.id,
          correlationId,
          action: AuditAction.MapRetired,
          subject: { type: AuditSubjectType.Map, id },
          details: { key: map.key, spacesRetired: map.spaces.retired },
        });
        continue;
      }
      await writeAuditEntry(tx, {
        actorUserId: admin.id,
        correlationId,
        action: AuditAction.MapSynced,
        subject: { type: AuditSubjectType.Map, id },
        details: {
          key: map.key,
          version: map.version ?? '',
          outcome: map.outcome,
          isEntry: map.isEntry,
          spacesAdded: map.spaces.added.map((space) => space.key),
          spacesRestored: map.spaces.restored,
          spacesRetired: map.spaces.retired,
        },
      });
    }
  }
}

/** The advisory lock every sync takes, or false at once if another holds it. */
async function tryLock(tx: DbExecutor): Promise<boolean> {
  const result = (await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended('maps:sync', 0)) as locked`,
  )) as unknown;
  // postgres.js answers with the rows; PGlite, in the tests, with an object
  // holding them.
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: unknown[] }).rows;
  return (rows[0] as { locked: boolean }).locked === true;
}

/**
 * One sync's work, inside its transaction: the rows as they were when it
 * started, what it has found to say about each map, and which of the kinds
 * the campus has one of are taken. Run once, in this order:
 *
 * 1. retire what is no longer published, before anything is added;
 * 2. take the entry flag off the map that no longer holds it;
 * 3. add or restore each published map and its spaces.
 */
class Reconciliation {
  private readonly results = new Map<string, MapSyncMapDto>();
  private readonly publishedByKey: Map<string, PublishedMap>;
  private known: MapRow[] = [];
  private knownSpaces: Space[] = [];

  constructor(
    private readonly tx: DbExecutor,
    private readonly now: Date,
    private readonly publishedMaps: PublishedMap[],
  ) {
    this.publishedByKey = new Map(publishedMaps.map((map) => [map.key, map]));
  }

  async run(): Promise<MapSyncResultDto> {
    this.known = await this.tx.select().from(maps).orderBy(asc(maps.key));
    this.knownSpaces = await this.tx.select().from(spaces);

    await this.retireUnpublished();
    await this.moveEntryFlag();

    const singletons = this.singletonsStaying();
    const restorable = this.reserveRestored(singletons);
    for (const published of this.publishedMaps) {
      await this.adopt(published, singletons, restorable);
    }
    // Refused as a whole, as anything unfit to adopt is: the transaction this
    // runs in takes back whatever was written before the conflict was found.
    if (singletons.conflicts.length > 0) {
      throw new PublishedMapsRejectedException(
        'The published maps cannot be adopted as they are.',
        singletons.conflicts,
      );
    }

    const all = [...this.results.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    return {
      dryRun: false,
      changed: all.some((map) => map.outcome !== MapSyncOutcome.Unchanged),
      maps: all,
    };
  }

  /**
   * Retires every map no longer published, with all its spaces, and every
   * space no longer drawn on a map that still is. First, everywhere, before
   * anything is added: a kind the campus has one of may be moving from a
   * space that is going to one that is arriving, and the database checks
   * that after each statement, so the old one has to be out of the way.
   */
  private async retireUnpublished(): Promise<void> {
    for (const map of this.known) {
      const stillPublished = this.publishedByKey.get(map.key);
      const live = this.knownSpaces.filter(
        (space) => space.mapId === map.id && space.retiredAt === null,
      );

      if (!stillPublished) {
        if (map.retiredAt !== null) {
          continue; // Retired already, and still gone: nothing to say.
        }
        const result = blank(map.key, null, false, MapSyncOutcome.Retired);
        result.spaces.retired = live
          .filter((space) => !space.isMapDefault)
          .map((space) => space.key)
          .sort();
        await this.tx
          .update(spaces)
          .set({ retiredAt: this.now })
          .where(and(eq(spaces.mapId, map.id), isNull(spaces.retiredAt)));
        await this.tx
          .update(maps)
          .set({ retiredAt: this.now, isEntry: false })
          .where(eq(maps.id, map.id));
        this.results.set(map.key, result);
        continue;
      }

      const drawn = new Set(stillPublished.spaces.map((space) => space.key));
      const gone = live.filter(
        (space) => !space.isMapDefault && !drawn.has(space.key),
      );
      for (const space of gone) {
        await this.tx
          .update(spaces)
          .set({ retiredAt: this.now })
          .where(eq(spaces.id, space.id));
        space.retiredAt = this.now;
      }
      const result = blank(
        map.key,
        stillPublished.version,
        stillPublished.isEntry,
        MapSyncOutcome.Unchanged,
      );
      result.spaces.retired = gone.map((space) => space.key).sort();
      this.results.set(map.key, result);
    }
  }

  /**
   * Takes the entry flag off whatever no longer holds it, before it is put
   * on what does: the database allows one entry map at a time.
   */
  private async moveEntryFlag(): Promise<void> {
    const entryKey = this.publishedMaps.find((map) => map.isEntry)?.key;
    await this.tx
      .update(maps)
      .set({ isEntry: false })
      .where(
        and(
          eq(maps.isEntry, true),
          entryKey ? ne(maps.key, entryKey) : undefined,
        ),
      );
  }

  /**
   * The kinds the campus has one of, held by a space that is staying. A
   * space on a map retired a moment ago was retired with it.
   */
  private singletonsStaying(): Singletons {
    const singletons = new Singletons();
    for (const space of this.knownSpaces) {
      const map = this.known.find((known) => known.id === space.mapId);
      if (
        space.retiredAt === null &&
        space.kind !== null &&
        map &&
        this.publishedByKey.has(map.key)
      ) {
        singletons.hold(space.kind, label(space.key, map.key));
      }
    }
    return singletons;
  }

  /**
   * Which retired spaces coming back may keep their kind, decided before any
   * new space is given one: a space that already was the town hall has a
   * better claim to it than one the map merely suggests, whichever comes
   * first on the map. Considered by map key, then space key, so the answer
   * never depends on the order Sanity lists things in. A space refused here
   * refuses the sync (see Singletons).
   */
  private reserveRestored(singletons: Singletons): Set<string> {
    const returning: {
      row: Space;
      mapKey: string;
      holder: string;
    }[] = [];
    for (const published of this.publishedMaps) {
      const map = this.known.find((known) => known.key === published.key);
      if (!map) continue;
      for (const drawn of published.spaces) {
        const row = this.knownSpaces.find(
          (space) =>
            space.mapId === map.id &&
            space.key === drawn.key &&
            space.retiredAt !== null,
        );
        if (row) {
          returning.push({
            row,
            mapKey: map.key,
            holder: label(drawn.key, map.key),
          });
        }
      }
    }
    returning.sort(
      (a, b) =>
        a.mapKey.localeCompare(b.mapKey) || a.row.key.localeCompare(b.row.key),
    );

    const restorable = new Set<string>();
    for (const { row, holder } of returning) {
      if (singletons.restore(row.kind, holder)) restorable.add(row.id);
    }
    return restorable;
  }

  /** Adds or restores one published map, its default space and its spaces. */
  private async adopt(
    published: PublishedMap,
    singletons: Singletons,
    restorable: ReadonlySet<string>,
  ): Promise<void> {
    const { mapId, result } = await this.adoptMap(published);
    const mine = this.knownSpaces.filter((space) => space.mapId === mapId);

    await this.ensureDefaultSpace(mapId, mine, result);

    for (const drawn of published.spaces) {
      const row = mine.find((space) => space.key === drawn.key);
      if (!row) {
        const kind = singletons.suggest(
          suggestedKind(drawn.tiledClass),
          label(drawn.key, published.key),
        );
        await this.tx.insert(spaces).values({
          mapId,
          key: drawn.key,
          name: drawn.name,
          kind,
          ...defaultsFor(kind),
          createdAt: this.now,
          updatedAt: this.now,
        });
        result.spaces.added.push({ key: drawn.key, name: drawn.name, kind });
        if (kind === null) result.spaces.needsKind.push(drawn.key);
        continue;
      }

      if (row.retiredAt !== null) {
        // It comes back as it was. Its kind may be one the campus has one of,
        // given to another space since: then the sync is refused (see
        // reserveRestored), not the kind quietly taken away.
        if (!restorable.has(row.id)) {
          continue;
        }
        await this.tx
          .update(spaces)
          .set({ retiredAt: null })
          .where(eq(spaces.id, row.id));
        result.spaces.restored.push(drawn.key);
        if (row.kind === null) result.spaces.needsKind.push(drawn.key);
      } else if (row.kind === null) {
        result.spaces.needsKind.push(drawn.key);
      }
    }

    const spacesChanged =
      result.spaces.added.length > 0 ||
      result.spaces.restored.length > 0 ||
      result.spaces.retired.length > 0;
    if (spacesChanged && result.outcome === MapSyncOutcome.Unchanged) {
      result.outcome = MapSyncOutcome.Updated;
    }
    result.spaces.needsKind.sort();
  }

  /** The map's row: inserted, restored, given or relieved of the entry flag. */
  private async adoptMap(
    published: PublishedMap,
  ): Promise<{ mapId: string; result: MapSyncMapDto }> {
    const existing = this.known.find((map) => map.key === published.key);

    if (!existing) {
      const [row] = await this.tx
        .insert(maps)
        .values({
          key: published.key,
          // The map carries no name; its ID is the best there is until an
          // admin gives it one.
          name: published.key,
          isEntry: published.isEntry,
          createdAt: this.now,
          updatedAt: this.now,
        })
        .returning({ id: maps.id });
      const result = blank(
        published.key,
        published.version,
        published.isEntry,
        MapSyncOutcome.Created,
      );
      this.results.set(published.key, result);
      return { mapId: row.id, result };
    }

    const result =
      this.results.get(published.key) ??
      blank(
        published.key,
        published.version,
        published.isEntry,
        MapSyncOutcome.Unchanged,
      );
    this.results.set(published.key, result);
    const wasRetired = existing.retiredAt !== null;
    if (wasRetired || existing.isEntry !== published.isEntry) {
      await this.tx
        .update(maps)
        .set({ retiredAt: null, isEntry: published.isEntry })
        .where(eq(maps.id, existing.id));
      result.outcome = wasRetired
        ? MapSyncOutcome.Restored
        : MapSyncOutcome.Updated;
    }
    return { mapId: existing.id, result };
  }

  /** Every map has one, and this is what sees to it. */
  private async ensureDefaultSpace(
    mapId: string,
    mine: Space[],
    result: MapSyncMapDto,
  ): Promise<void> {
    const fallback = mine.find((space) => space.isMapDefault);
    if (!fallback) {
      await this.tx.insert(spaces).values({
        mapId,
        key: DEFAULT_SPACE_KEY,
        name: DEFAULT_SPACE_NAME,
        kind: SpaceKind.Open,
        isMapDefault: true,
        ...defaultsFor(SpaceKind.Open),
        createdAt: this.now,
        updatedAt: this.now,
      });
    } else if (fallback.retiredAt !== null) {
      await this.tx
        .update(spaces)
        .set({ retiredAt: null })
        .where(eq(spaces.id, fallback.id));
    } else {
      return;
    }
    if (result.outcome === MapSyncOutcome.Unchanged) {
      // A map that had lost its default, or had it retired on its own, is
      // changed by getting it back.
      result.outcome = MapSyncOutcome.Updated;
    }
  }
}

/**
 * The kinds the campus has one of (a town hall, a notice board), and which
 * space holds each. The database refuses a second; this is what keeps a
 * sync from asking it to, and from taking a kind away to make room.
 */
class Singletons {
  private readonly holders = new Map<SpaceKind, string>();
  /** Restores refused for want of a kind another space holds, one line each. */
  readonly conflicts: string[] = [];

  hold(kind: SpaceKind, holder: string): void {
    if (SINGLETON_KINDS.has(kind)) this.holders.set(kind, holder);
  }

  /**
   * For a new space, which has no kind yet to lose: the kind its map
   * suggests, unless that is one the campus has one of and it is taken.
   * Then no kind, for an admin to decide.
   */
  suggest(kind: SpaceKind | null, holder: string): SpaceKind | null {
    if (kind === null || !SINGLETON_KINDS.has(kind)) return kind;
    if (this.holders.has(kind)) return null;
    this.holders.set(kind, holder);
    return kind;
  }

  /**
   * For a space coming back with the kind it had. False, with the conflict
   * noted, when another space holds that kind now: restoring it would mean
   * a second, or wiping the kind an admin may have given it.
   */
  restore(kind: SpaceKind | null, holder: string): boolean {
    if (kind === null || !SINGLETON_KINDS.has(kind)) return true;
    const current = this.holders.get(kind);
    if (current === undefined) {
      this.holders.set(kind, holder);
      return true;
    }
    const name = kind.replaceAll('_', ' ');
    this.conflicts.push(
      `Space ${holder} is published again and was the campus's ${name}, but ${current} is the ${name} now. Unpublish one of them.`,
    );
    return false;
  }
}

function label(spaceKey: string, mapKey: string): string {
  return `"${spaceKey}" on "${mapKey}"`;
}

function blank(
  key: string,
  version: string | null,
  isEntry: boolean,
  outcome: MapSyncOutcome,
): MapSyncMapDto {
  return {
    key,
    version,
    isEntry,
    outcome,
    spaces: { added: [], restored: [], retired: [], needsKind: [] },
  };
}
