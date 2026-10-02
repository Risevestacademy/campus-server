import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { IsCatalogCode } from '../../../shared/dto/catalog-code.js';
import { CohortStatus } from '../schema.js';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A partial cohort edit: only the fields present are written. The same rules
 * as create apply to whatever is sent, and the end-after-start check runs on
 * the merged row in the service, since changing one date can invert a pair
 * whose other half is already stored.
 */
export class UpdateCohortDto {
  @ApiPropertyOptional({ example: 'Cohort 1', maxLength: 128 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({
    example: 'C1',
    maxLength: 32,
    description: 'Unique across cohorts. Stored uppercase.',
  })
  @IsOptional()
  @IsCatalogCode()
  code?: string;

  @ApiPropertyOptional({ type: String, format: 'date', example: '2026-09-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2027-06-30',
    description: 'On or after startDate.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

  @ApiPropertyOptional({
    enum: CohortStatus,
    enumName: 'CohortStatus',
  })
  @IsOptional()
  @IsEnum(CohortStatus)
  status?: CohortStatus;
}
