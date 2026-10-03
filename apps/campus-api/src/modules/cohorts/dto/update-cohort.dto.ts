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
import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';
import { CohortStatus } from '../schema.js';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A partial cohort edit: only the fields present are written. The same rules
 * as create apply to whatever is sent, and the end-after-start check runs on
 * the merged row in the service, since changing one date can invert a pair
 * whose other half is already stored.
 *
 * Name, code and status can be changed but not cleared, so null is refused.
 * The dates are optional at create, so null is how one is cleared.
 */
export class UpdateCohortDto {
  @ApiPropertyOptional({ example: 'Cohort 1', maxLength: 128 })
  @IsOptionalNotNull()
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
  @IsOptionalNotNull()
  @IsCatalogCode()
  code?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-09-01',
    description: 'Null clears it.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-06-30',
    description: 'On or after startDate. Null clears it.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string | null;

  @ApiPropertyOptional({
    enum: CohortStatus,
    enumName: 'CohortStatus',
  })
  @IsOptionalNotNull()
  @IsEnum(CohortStatus)
  status?: CohortStatus;
}
