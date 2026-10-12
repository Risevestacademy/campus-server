import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { UserStatus } from '../schema.js';

export const SUSPENSION_REASON_MAX_LENGTH = 500;

/**
 * Why the account is being suspended. Optional on purpose: an admin may
 * suspend for something everybody can see and need not write it down twice.
 */
export class SuspendUserDto {
  @ApiPropertyOptional({
    example: 'Posted the answer to a live assessment.',
    maxLength: SUSPENSION_REASON_MAX_LENGTH,
    description:
      'Why, in the admin’s own words. Kept in the audit log beside the ' +
      'actor and the target — nowhere else on the account — so a list or a ' +
      'card never shows it. Blank is taken as no reason rather than ' +
      'refused, since the field is optional.',
  })
  // Trimmed first, so a message of spaces is no reason rather than a reason
  // that says nothing. NUL goes too: Postgres refuses it in text, and that
  // would be a 500 for a character nobody can see.
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.replaceAll('\u0000', '').trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(SUSPENSION_REASON_MAX_LENGTH)
  reason?: string;
}

/** The account after the change, as much as the caller needs to redraw a row. */
export class UserStatusDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({ example: 'ada@campus.local' })
  email: string;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;
}
