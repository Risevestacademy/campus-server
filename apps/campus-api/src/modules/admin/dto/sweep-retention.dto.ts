import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

import { MIN_RETENTION_DAYS } from '../../../infra/config/env.js';
import { RetentionTable } from '../retention.service.js';

export class SweepRetentionDto {
  /**
   * The one table to sweep. Omitted, both are, each with its configured
   * period. Required with `retentionDays`.
   */
  @ApiPropertyOptional({ enum: RetentionTable, enumName: 'RetentionTable' })
  @ValidateIf(
    (o: SweepRetentionDto) =>
      o.table !== undefined || o.retentionDays !== undefined,
  )
  @IsEnum(RetentionTable, {
    message: `table must be one of: ${Object.values(RetentionTable).join(', ')}, and is required with retentionDays`,
  })
  table?: RetentionTable;

  /**
   * Overrides the configured period for this one sweep, for a one-off
   * cleanup. Rows younger than this are never deleted. At least 30.
   * @example 60
   */
  @IsOptional()
  @IsInt()
  @Min(MIN_RETENTION_DAYS)
  retentionDays?: number;
}

export class RetentionSweepResultDto {
  @ApiProperty({ enum: RetentionTable, enumName: 'RetentionTable' })
  table: RetentionTable;

  /** @example 128 */
  deleted: number;

  /**
   * Rows created before this instant were deleted.
   * @example 2026-08-07T09:30:00.000Z
   */
  cutoff: Date;

  /** @example 90 */
  retentionDays: number;
}

export class SweepRetentionResponseDto {
  /** One per table swept, in the order they ran. */
  @ApiProperty({ type: [RetentionSweepResultDto] })
  swept: RetentionSweepResultDto[];
}
