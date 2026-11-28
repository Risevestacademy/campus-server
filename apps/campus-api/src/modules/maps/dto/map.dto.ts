import { ApiProperty } from '@nestjs/swagger';

/** One map the database knows of, live or retired. */
export class MapResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  /** The map's ID in Sanity. @example campus */
  key: string;

  /** @example Campus */
  name: string;

  /** Whether this is the map people enter on: the only one that can be published. */
  isEntry: boolean;

  /** Null while the map is still published in Sanity. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;

  /**
   * The Sanity version the last sync read. Null until a sync has run since
   * versions were recorded.
   * @example 3f9c2a
   */
  @ApiProperty({ type: String, nullable: true })
  syncedVersion: string | null;

  /** When a sync first read `syncedVersion`. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  syncedAt: Date | null;

  /** When an admin last published the map. Null if never. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;

  /**
   * The synced version at the last publish. When it differs from
   * `syncedVersion`, the latest sync has not been published.
   * @example 3f9c2a
   */
  @ApiProperty({ type: String, nullable: true })
  publishedVersion: string | null;
}
