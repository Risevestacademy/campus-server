import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { type AuditContext, writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import type { MapPublishedResponseDto } from './dto/map-publish.dto.js';
import {
  MapNotEntryException,
  MapNotFoundException,
  MapRetiredException,
} from './maps.exceptions.js';
import { maps } from './schema.js';
import { MAPS_NOTIFY, type MapNotifier } from './tell-world.js';

/**
 * Makes a synced map live for world. The sync writes what is published; this
 * is the admin's separate decision to serve it, so a map can be synced and
 * still not be live.
 *
 * The row is locked before it is read, so the timestamp this publish
 * replaces is the one the update actually replaces. The audit entry is in
 * the same transaction; the notification is sent after commit, so a
 * notification that fails is logged and the publish still stands.
 */
@Injectable()
export class MapPublishService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(MAPS_NOTIFY) private readonly notify: MapNotifier,
    private readonly logger: PinoLogger,
  ) {}

  async publish(
    id: string,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<MapPublishedResponseDto> {
    const published = await this.db.transaction(async (tx) => {
      const [map] = await tx
        .select()
        .from(maps)
        .where(eq(maps.id, id))
        .for('update');
      if (!map) {
        throw new MapNotFoundException(`Map ${id} not found`, { mapId: id });
      }
      if (map.retiredAt !== null) {
        throw new MapRetiredException(
          `Map "${map.key}" is retired and cannot be published`,
          { mapId: id, key: map.key },
        );
      }
      if (!map.isEntry) {
        throw new MapNotEntryException(
          `Map "${map.key}" is not the map people enter on, and world serves one map`,
          { mapId: id, key: map.key },
        );
      }

      const [row] = await tx
        .update(maps)
        .set({ publishedAt: now })
        .where(eq(maps.id, id))
        .returning();

      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.MapPublished,
        subject: { type: AuditSubjectType.Map, id },
        details: {
          key: map.key,
          previousPublishedAt: map.publishedAt,
          publishedAt: row.publishedAt ?? now,
        },
      });

      return {
        id: row.id,
        key: row.key,
        publishedAt: row.publishedAt ?? now,
      };
    });

    // Postgres delivers a notify only on commit. Sent with the pool rather
    // than the transaction so a failed notification cannot roll the publish
    // back: it is the difference from a space edit, whose notify is inside
    // its transaction because every part of it must stand together.
    try {
      await this.notify(this.db, published.key);
    } catch (err) {
      this.logger.warn(
        { err, mapId: published.id, mapKey: published.key },
        'could not tell world a map was published',
      );
    }

    return published;
  }
}
