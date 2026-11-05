import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** The map the admin is publishing. The id comes from the URL, never a body. */
export class MapIdParamDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  @IsUUID()
  id: string;
}

/** What a publish answers: which map went live, and when. */
export class MapPublishedResponseDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  id: string;

  /** The map's ID in Sanity. @example campus */
  key: string;

  /** When this publish made it live. */
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
}
