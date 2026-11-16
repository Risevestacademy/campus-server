import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class DeskCohortParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;
}

export class DeskParamDto extends DeskCohortParamDto {
  /**
   * The desk's key: its object's name in Tiled.
   * @example desk_a1
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  key: string;
}

export class DeskHolderDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /** @example "Ada Lovelace" */
  displayName: string | null;
}

/** A desk on the published map, and who holds it in this cohort. */
export class DeskDto {
  /** @example desk_a1 */
  key: string;

  /**
   * The map the desk is drawn on.
   * @example campus
   */
  mapKey: string;

  /** Null when nobody holds it in this cohort. */
  @ApiProperty({ type: DeskHolderDto, nullable: true })
  holder: DeskHolderDto | null;

  /**
   * When the holder claimed it. Null when nobody holds it.
   * @example 2026-11-03T09:00:00.000Z
   */
  claimedAt: Date | null;
}
