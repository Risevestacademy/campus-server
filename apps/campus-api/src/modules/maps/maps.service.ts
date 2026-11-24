import { Inject, Injectable } from '@nestjs/common';
import { asc, desc } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { MapResponseDto } from './dto/map.dto.js';
import { maps } from './schema.js';

@Injectable()
export class MapsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Every map, retired ones included: the entry map first, then by key. */
  list(): Promise<MapResponseDto[]> {
    return this.db
      .select({
        id: maps.id,
        key: maps.key,
        name: maps.name,
        isEntry: maps.isEntry,
        retiredAt: maps.retiredAt,
        syncedVersion: maps.syncedVersion,
        syncedAt: maps.syncedAt,
        publishedAt: maps.publishedAt,
        publishedVersion: maps.publishedVersion,
      })
      .from(maps)
      .orderBy(desc(maps.isEntry), asc(maps.key));
  }
}
