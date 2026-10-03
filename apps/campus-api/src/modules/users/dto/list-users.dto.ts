import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole, UserStatus } from '../schema.js';

/**
 * Pagination plus the filters, every one optional and all of them combined
 * with AND.
 *
 * The three membership filters — cohort, track, cohort role — are answered by
 * one membership, not by any mix of several: `cohortId` with
 * `cohortRole=mentor` means a mentor in that cohort, never somebody who is in
 * that cohort and a mentor somewhere else.
 */
export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'ada',
    maxLength: 128,
    description:
      'Matches any part of the email address, first name, last name, full ' +
      'name or display name, ignoring case.',
  })
  @IsOptional()
  // NUL is dropped: Postgres refuses it in text, which would be a 500.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value,
  )
  @IsString()
  @MaxLength(128)
  search?: string;

  @ApiPropertyOptional({ enum: SystemRole, enumName: 'SystemRole' })
  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;

  @ApiPropertyOptional({
    enum: UserStatus,
    enumName: 'UserStatus',
    description: 'The account’s own status, not a membership’s.',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description: 'People with a live membership in this cohort.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '55555555-5555-4555-8555-555555555555',
    description:
      'People with a live membership on this track, in any cohort that ' +
      'runs it. Send `cohortId` as well for one cohort’s intake of the ' +
      'track. Only students are placed on a track, so this finds students.',
  })
  @IsOptional()
  @IsUUID()
  trackId?: string;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    description: 'People holding this role in a live membership.',
  })
  @IsOptional()
  @IsEnum(CohortRole)
  cohortRole?: CohortRole;
}
