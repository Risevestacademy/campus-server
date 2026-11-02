import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { SpaceKind } from '../schema.js';

export class MapSyncQueryDto {
  /**
   * Work out what a sync would change, and change nothing. The answer is
   * exactly what the real one would be, because it is the real one, undone
   * before it is kept.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  dryRun: boolean = false;
}

/** What became of one map in a sync. */
export enum MapSyncOutcome {
  /** New to the database. */
  Created = 'created',
  /** Was retired, and is published again. */
  Restored = 'restored',
  /** Already known; its entry flag or its spaces changed. */
  Updated = 'updated',
  /** Already known, and nothing about it changed. */
  Unchanged = 'unchanged',
  /** No longer published. Its row and its spaces stay, marked retired. */
  Retired = 'retired',
}

export class SyncedSpaceDto {
  /** @example library */
  key: string;

  /** @example Library */
  name: string;

  /**
   * Null when the map suggested no kind this knows. The space is then not set
   * up, and nobody but admins may enter it.
   */
  @ApiProperty({ enum: SpaceKind, enumName: 'SpaceKind', nullable: true })
  kind: SpaceKind | null;
}

export class MapSyncSpacesDto {
  /** Spaces new to the database, with the kind each was given. */
  added: SyncedSpaceDto[];

  /**
   * Spaces that were retired and are on the map again, with the settings they
   * had.
   * @example ["library"]
   */
  restored: string[];

  /**
   * Spaces no longer on the map. Their rows stay, marked retired.
   * @example ["old-lab"]
   */
  retired: string[];

  /**
   * Every live space on the map with no kind set, after this sync: the ones
   * waiting for an admin, whenever they were added.
   * @example ["room_space_1"]
   */
  needsKind: string[];
}

export class MapSyncMapDto {
  /**
   * The map’s ID in Sanity.
   * @example campus
   */
  key: string;

  /**
   * The published version that was read. Null for a map that is no longer
   * published.
   * @example d686dbad05445e71
   */
  version: string | null;

  /** Whether this is the map people enter on. */
  isEntry: boolean;

  @ApiProperty({ enum: MapSyncOutcome, enumName: 'MapSyncOutcome' })
  outcome: MapSyncOutcome;

  spaces: MapSyncSpacesDto;
}

export class MapSyncResultDto {
  /** True when nothing was kept: this was a look, not a sync. */
  dryRun: boolean;

  /**
   * Whether anything changed, or would have. False means the database already
   * matched what is published.
   */
  changed: boolean;

  maps: MapSyncMapDto[];
}
