import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';

/**
 * In the body rather than the query string: request URLs are logged, and the
 * token is what makes the link work.
 */
export class InvitePreviewRequestDto {
  @ApiProperty({
    example: 'hFiA6EvJBOTvjt53b6SuvRAOCUiWl7umU4OWZl08WnU',
    description: 'The `token` from the invite link, exactly as it arrived.',
  })
  // Checked bottom-up, and only the first failure is reported: emptiness
  // first, or a missing token is described as too long.
  @MaxLength(256)
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class InvitePreviewCohortDto {
  @ApiProperty({ example: 'Product Design 2026' })
  name: string;

  @ApiProperty({ example: 'PD26' })
  code: string;

  @ApiPropertyOptional({ type: String, example: '2026-09-01', nullable: true })
  startDate: string | null;

  @ApiPropertyOptional({ type: String, example: '2027-06-30', nullable: true })
  endDate: string | null;
}

export class InvitePreviewTrackDto {
  @ApiProperty({ example: 'Product Design' })
  name: string;

  @ApiProperty({ example: 'PD' })
  code: string;
}

export class InvitePreviewInviterDto {
  @ApiPropertyOptional({ type: String, example: 'Jerry', nullable: true })
  firstName: string | null;

  @ApiPropertyOptional({ type: String, example: 'Smith', nullable: true })
  lastName: string | null;
}

/**
 * What the invitation screen shows before sign-in. Deliberately carries no
 * ids: it is public to whoever holds the link, and nothing in it is meant to
 * be acted on — accepting still takes a Google sign-in as the invited address.
 */
export class InvitePreviewResponseDto {
  @ApiProperty({
    example: 'ada@campus.local',
    description:
      'The address the invite was sent to. Show it beside "Continue with ' +
      'Google": signing in with any other account is refused with ' +
      'invite_required.',
  })
  email: string;

  @ApiProperty({
    type: () => InvitePreviewCohortDto,
    nullable: true,
    description: 'Null for an admin invite, which joins no cohort.',
  })
  cohort: InvitePreviewCohortDto | null;

  @ApiProperty({
    type: () => InvitePreviewTrackDto,
    nullable: true,
    description: 'Set for students; null for every other role.',
  })
  track: InvitePreviewTrackDto | null;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    nullable: true,
    description: 'Null for an admin invite — show systemRole instead.',
  })
  cohortRole: CohortRole | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ type: () => InvitePreviewInviterDto })
  invitedBy: InvitePreviewInviterDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-07T12:00:00.000Z',
    description: 'When the link stops working.',
  })
  expiresAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'Guests only: when the visit being offered ends. Say so before they ' +
      'accept.',
  })
  guestAccessExpiresAt: Date | null;
}
