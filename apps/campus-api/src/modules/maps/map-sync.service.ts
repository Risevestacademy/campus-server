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
import { PublishedMapsReader, type PublishedMap } from './published-maps.js';
import { SpaceKind, maps, spaces } from './schema.js';
import {
  DEFAULT_SPACE_KEY,
  DEFAULT_SPACE_NAME,
  SINGLETON_KINDS,
  defaultsFor,
  suggestedKind,
} from './space-defaults.js';

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
 *   a kind, not a setting. A sync only adds, retires and restores.
 * - Every map is given its default space, for the tiles inside no drawn
 *   one. The database stops a map having two; this is what makes sure it
 *   has one.
 *
 * All of it happens in one transaction or not at all, after the published
 * maps have been read whole and found fit to adopt. A sync that finds
 * nothing to change writes nothing, an audit entry included.
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
    // Read first, outside the transaction: it is a call to another service,
    // and a transaction held open across one holds its locks for as long as
    // that service takes to answer.
    const publishedMaps = await this.published.read();
    const dryRun = options.dryRun ?? false;

    try {
      return await this.db.transaction(async (tx) => {
        // One sync at a time. Two at once would each read the rows as they
        // were, and each insert what the other was about to.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('maps:sync', 0))`,
        );

        const result = await this.apply(tx, publishedMaps, now);
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

  private async apply(
    tx: DbExecutor,
    publishedMaps: PublishedMap[],
    now: Date,
  ): Promise<MapSyncResultDto> {
    const known = await tx.select().from(maps).orderBy(asc(maps.key));
    const knownSpaces = await tx.select().from(spaces);
    const publishedByKey = new Map(publishedMaps.map((map) => [map.key, map]));
    const results = new Map<string, MapSyncMapDto>();

    const blank = (
      key: string,
      version: string | null,
      isEntry: boolean,
      outcome: MapSyncOutcome,
    ): MapSyncMapDto => ({
      key,
      version,
      isEntry,
      outcome,
      spaces: { added: [], restored: [], retired: [], needsKind: [] },
    });

    // 1. Retire first, everywhere, before anything is added. A kind the
    //    campus has one of may be moving from a space that is going to one
    //    that is arriving, and the database checks that after each statement:
    //    the old one has to be out of the way before the new one is written.
    for (const map of known) {
      const stillPublished = publishedByKey.get(map.key);
      const live = knownSpaces.filter(
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
        await tx
          .update(spaces)
          .set({ retiredAt: now })
          .where(and(eq(spaces.mapId, map.id), isNull(spaces.retiredAt)));
        await tx
          .update(maps)
          .set({ retiredAt: now, isEntry: false })
          .where(eq(maps.id, map.id));
        results.set(map.key, result);
        continue;
      }

      const drawn = new Set(stillPublished.spaces.map((space) => space.key));
      const gone = live.filter(
        (space) => !space.isMapDefault && !drawn.has(space.key),
      );
      if (gone.length > 0) {
        for (const space of gone) {
          await tx
            .update(spaces)
            .set({ retiredAt: now })
            .where(eq(spaces.id, space.id));
          space.retiredAt = now;
        }
      }
      const result = blank(
        map.key,
        stillPublished.version,
        stillPublished.isEntry,
        MapSyncOutcome.Unchanged,
      );
      result.spaces.retired = gone.map((space) => space.key).sort();
      results.set(map.key, result);
    }

    // 2. The entry flag. Taken off whatever no longer holds it before it is
    //    put on what does: the database allows one entry map at a time.
    const entryKey = publishedMaps.find((map) => map.isEntry)?.key;
    await tx
      .update(maps)
      .set({ isEntry: false })
      .where(
        and(
          eq(maps.isEntry, true),
          entryKey ? ne(maps.key, entryKey) : undefined,
        ),
      );

    // The kinds the campus has one of, and which are taken by a space that
    // is staying. Filled in as this sync hands them out, too.
    const taken = new Set<SpaceKind>(
      knownSpaces
        .filter(
          (space) =>
            space.retiredAt === null &&
            space.kind !== null &&
            SINGLETON_KINDS.has(space.kind) &&
            // A space on a map retired a moment ago was retired with it.
            publishedByKey.has(
              known.find((map) => map.id === space.mapId)?.key ?? '',
            ),
        )
        .map((space) => space.kind as SpaceKind),
    );
    /** The kind a space may have: its own, unless the campus's one is taken. */
    const free = (kind: SpaceKind | null): SpaceKind | null => {
      if (kind === null || !SINGLETON_KINDS.has(kind)) return kind;
      if (taken.has(kind)) return null;
      taken.add(kind);
      return kind;
    };

    // 3. Add and restore.
    for (const published of publishedMaps) {
      const existing = known.find((map) => map.key === published.key);
      let result = results.get(published.key);
      let mapId: string;

      if (!existing) {
        const [row] = await tx
          .insert(maps)
          .values({
            key: published.key,
            // The map carries no name; its ID is the best there is until an
            // admin gives it one.
            name: published.key,
            isEntry: published.isEntry,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: maps.id });
        mapId = row.id;
        result = blank(
          published.key,
          published.version,
          published.isEntry,
          MapSyncOutcome.Created,
        );
        results.set(published.key, result);
      } else {
        mapId = existing.id;
        result ??= blank(
          published.key,
          published.version,
          published.isEntry,
          MapSyncOutcome.Unchanged,
        );
        results.set(published.key, result);
        const wasRetired = existing.retiredAt !== null;
        if (wasRetired || existing.isEntry !== published.isEntry) {
          await tx
            .update(maps)
            .set({ retiredAt: null, isEntry: published.isEntry })
            .where(eq(maps.id, mapId));
          result.outcome = wasRetired
            ? MapSyncOutcome.Restored
            : MapSyncOutcome.Updated;
        }
      }

      const mine = knownSpaces.filter((space) => space.mapId === mapId);

      // The default space: every map has one, and this is what sees to it.
      const fallback = mine.find((space) => space.isMapDefault);
      if (!fallback) {
        await tx.insert(spaces).values({
          mapId,
          key: DEFAULT_SPACE_KEY,
          name: DEFAULT_SPACE_NAME,
          kind: SpaceKind.Open,
          isMapDefault: true,
          ...defaultsFor(SpaceKind.Open),
          createdAt: now,
          updatedAt: now,
        });
        if (result.outcome === MapSyncOutcome.Unchanged) {
          // A map that had lost its default is changed by getting one back.
          result.outcome = MapSyncOutcome.Updated;
        }
      } else if (fallback.retiredAt !== null) {
        await tx
          .update(spaces)
          .set({ retiredAt: null })
          .where(eq(spaces.id, fallback.id));
        if (result.outcome === MapSyncOutcome.Unchanged) {
          // Retired on a map that was not: the same as having lost it.
          result.outcome = MapSyncOutcome.Updated;
        }
      }

      for (const drawn of published.spaces) {
        const row = mine.find((space) => space.key === drawn.key);
        if (!row) {
          const kind = free(suggestedKind(drawn.tiledClass));
          await tx.insert(spaces).values({
            mapId,
            key: drawn.key,
            name: drawn.name,
            kind,
            ...defaultsFor(kind),
            createdAt: now,
            updatedAt: now,
          });
          result.spaces.added.push({ key: drawn.key, name: drawn.name, kind });
          if (kind === null) result.spaces.needsKind.push(drawn.key);
          continue;
        }

        if (row.retiredAt !== null) {
          // It comes back as it was, except that the campus's one town hall
          // or notice board may have been given to another space since. Then
          // this one comes back with no kind, for an admin to decide.
          const kind = free(row.kind);
          await tx
            .update(spaces)
            .set({ retiredAt: null, kind })
            .where(eq(spaces.id, row.id));
          result.spaces.restored.push(drawn.key);
          if (kind === null) result.spaces.needsKind.push(drawn.key);
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

    const all = [...results.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    return {
      dryRun: false,
      changed: all.some((map) => map.outcome !== MapSyncOutcome.Unchanged),
      maps: all,
    };
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
