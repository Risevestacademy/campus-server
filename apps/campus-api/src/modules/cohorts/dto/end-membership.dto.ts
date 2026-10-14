import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { CohortRole, StudentStatus } from '../schema.js';

/**
 * The five ways an admin ends a membership. The route names the action, so
 * it never travels in the body: the cohort and member come from the URL too.
 */
export enum MembershipEndAction {
  Dismiss = 'dismiss',
  Withdraw = 'withdraw',
  Defer = 'defer',
  Graduate = 'graduate',
  Remove = 'remove',
}

export const MEMBERSHIP_REASON_MAX_LENGTH = 500;

/**
 * Why a membership is ending. Required for a dismissal and optional for the
 * rest, so the same body serves every route; the service enforces the
 * dismissal case. Blank is taken as no reason rather than refused, since the
 * field is optional everywhere but there.
 */
export class EndMembershipDto {
  @ApiPropertyOptional({
    example: 'Posted the answer to a live assessment.',
    maxLength: MEMBERSHIP_REASON_MAX_LENGTH,
    description:
      'Why, in the admin’s own words. Required for a dismissal, optional ' +
      'for the other four. Kept on the membership and in the audit log, so ' +
      'the roster shows it under state=ended. Blank is taken as no reason ' +
      'rather than refused.',
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
  @MaxLength(MEMBERSHIP_REASON_MAX_LENGTH)
  reason?: string;
}

/** The membership after the change, with how it ended and why. */
export class EndMembershipResponseDto {
  @ApiProperty({
    example: '55555555-5555-4555-8555-555555555555',
    description: "The membership's own id.",
  })
  id: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  userId: string;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
    description:
      'The student status the end set; null for a removal, which carries ' +
      'no student status.',
  })
  status: StudentStatus | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-13T12:00:00.000Z',
    description: 'When the membership ended.',
  })
  leftAt: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Posted the answer to a live assessment.',
    description: 'What the admin wrote, or null when they wrote nothing.',
  })
  reason: string | null;
}
