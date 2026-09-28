import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsUUID,
} from 'class-validator';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';

/**
 * Two shapes are accepted (mirrors the INVITES CHECK constraints):
 *
 * - Cohort invite: { email, cohortId, cohortRole } plus optional
 *   cohortTrackId / mentorshipGroupId / systemRole / expiresAt. A guest is
 *   one of these, and the only one that carries guestAccessExpiresAt.
 * - Admin invite: { email, systemRole: 'admin' } with NO cohort fields.
 *
 * Everybody who is not an admin is invited to a cohort, so an invite naming
 * neither is refused: it would accept into nothing.
 *
 * An admin+cohort combination (systemRole admin together with cohort fields)
 * is also accepted: system_role is independent of cohort scoping, so an admin
 * who is also a professor on a cohort is expressible.
 *
 * Cross-field rules (also enforced by DB CHECKs, validated here for clean 400s):
 * - cohortId and cohortRole travel together (invites_cohort_pairing).
 * - cohortTrackId / mentorshipGroupId require cohortId
 *   (invites_scoped_fields_require_cohort).
 * - cohortRole 'student' requires cohortTrackId (invites_student_requires_track).
 */
export class CreateInviteDto {
  @ApiProperty({
    example: 'new.student@campus.local',
    description: 'Invitee address. Stored lowercase.',
  })
  @IsEmail()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiPropertyOptional({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Required for every invite but an admin one.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    example: CohortRole.Student,
    description: 'Required for every invite but an admin one.',
  })
  @IsOptional()
  @IsEnum(CohortRole)
  cohortRole?: CohortRole;

  @ApiPropertyOptional({
    example: '22222222-2222-4222-8222-222222222222',
    description:
      'Required when cohortRole is student. Must belong to cohortId.',
  })
  @IsOptional()
  @IsUUID()
  cohortTrackId?: string;

  @ApiPropertyOptional({
    example: '33333333-3333-4333-8333-333333333333',
    description: 'Optional pod assignment. Requires cohortId.',
  })
  @IsOptional()
  @IsUUID()
  mentorshipGroupId?: string;

  @ApiPropertyOptional({
    enum: SystemRole,
    enumName: 'SystemRole',
    example: SystemRole.User,
    description:
      "Defaults to 'user'. Admin invites pass 'admin' with no cohort fields.",
  })
  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;

  @ApiPropertyOptional({
    example: '2026-10-01T00:00:00.000Z',
    description: 'Defaults to now + INVITE_TTL_DAYS. Must be in the future.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    example: '2026-12-01T00:00:00.000Z',
    description:
      'When the guest stops being one — required for cohortRole guest, and ' +
      'rejected for every other role. Not the same as expiresAt, which is ' +
      'how long this invite stays redeemable.',
  })
  @IsOptional()
  @IsDateString()
  guestAccessExpiresAt?: string;
}
