import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

import { IsCatalogCode } from '../../../shared/dto/catalog-code.js';
import { CohortStatus } from '../schema.js';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date no earlier than the one in `property`. A request rule, so
 * it is reported like every other field error — under details.fields — and
 * passes when either date is absent, leaving the other rules to judge it.
 * YYYY-MM-DD strings compare in date order, so nothing is parsed.
 */
function IsOnOrAfter(
  property: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isOnOrAfter',
      constraints: [property],
      validator: {
        validate: (value: unknown, args) => {
          const object = args?.object as Record<string, unknown> | undefined;
          const other = object?.[property];
          return (
            typeof value !== 'string' ||
            typeof other !== 'string' ||
            value >= other
          );
        },
        defaultMessage: (args) =>
          `${args?.property} must be on or after ${property}`,
      },
    },
    options,
  );
}

export class CreateCohortDto {
  @ApiProperty({ example: 'Cohort 1', maxLength: 128 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiProperty({
    example: 'C1',
    maxLength: 32,
    description: 'Unique across cohorts. Stored uppercase.',
  })
  @IsCatalogCode()
  code: string;

  // Calendar dates, not instants: a cohort starts on a day, wherever the
  // admin happens to be. IsISO8601 strict rejects 2026-02-30; the pattern
  // rejects a full timestamp, which would otherwise pass as a valid ISO date.
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
  @IsOnOrAfter('startDate')
  endDate?: string;

  @ApiPropertyOptional({
    enum: CohortStatus,
    enumName: 'CohortStatus',
    default: CohortStatus.Upcoming,
  })
  @IsOptional()
  @IsEnum(CohortStatus)
  status?: CohortStatus;
}
