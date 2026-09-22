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
 * Exactly two shapes are accepted (mirrors the INVITES CHECK constraints):
 *
 * - Cohort invite: { email, cohortId, cohortRole } plus optional
 *   cohortTrackId / mentorshipGroupId / systemRole / expiresAt.
 * - Admin invite: { email, systemRole: 'admin' } with NO cohort fields.
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
    description: 'Cohort invite only. Null for admin/guest invites.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    example: CohortRole.Student,
    description: 'Cohort invite only. Null for admin/guest invites.',
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
}
