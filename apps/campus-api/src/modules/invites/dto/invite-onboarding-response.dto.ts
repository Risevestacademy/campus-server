import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CohortRole, CohortStatus } from '../../cohorts/schema.js';
import { SystemRole, UserStatus } from '../../users/schema.js';
import { InviteStatus } from '../schema.js';

/**
 * What the onboarding screen needs to render a decision. Deliberately not
 * InviteResponseDto: that is the admin's create-receipt and carries the raw
 * token and the shareable link, neither of which the invitee should be handed
 * a second time.
 */
export class InviteCohortDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  id: string;

  @ApiProperty({ example: 'Cohort 1' })
  name: string;

  @ApiProperty({ example: 'C1' })
  code: string;

  @ApiPropertyOptional({ type: String, example: '2026-09-01', nullable: true })
  startDate: string | null;

  @ApiPropertyOptional({ type: String, example: '2027-06-30', nullable: true })
  endDate: string | null;

  @ApiProperty({ enum: CohortStatus, enumName: 'CohortStatus' })
  status: CohortStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  updatedAt: Date;
}

/** The COHORT_TRACKS link row the invite points at, not the track itself. */
export class InviteCohortTrackDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  trackId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;
}

export class InviteTrackDto {
  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  id: string;

  @ApiProperty({ example: 'Software Engineering' })
  name: string;

  @ApiProperty({ example: 'SE' })
  code: string;

  @ApiPropertyOptional({
    type: String,
    example: 'Backend and infra',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  updatedAt: Date;
}

/**
 * Whoever sent the offer. Named for the field rather than the role:
 * INVITES.INVITED_BY is all the row records, so it does not assert they still
 * hold that role today.
 */
export class InvitedByDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  id: string;

  @ApiPropertyOptional({ type: String, example: 'Ada', nullable: true })
  firstName: string | null;

  @ApiPropertyOptional({ type: String, example: 'Lovelace', nullable: true })
  lastName: string | null;
}

/** The signed-in account, as read from the USERS row on this request. */
export class InviteInviteeDto {
  @ApiProperty({ example: '55555555-5555-4555-8555-555555555555' })
  id: string;

  @ApiProperty({ example: 'new.student@campus.local' })
  email: string;

  @ApiPropertyOptional({ type: String, example: 'New', nullable: true })
  firstName: string | null;

  @ApiPropertyOptional({ type: String, example: 'Student', nullable: true })
  lastName: string | null;

  @ApiPropertyOptional({ type: String, example: 'New Student', nullable: true })
  displayName: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;
}

export class InviteOnboardingResponseDto {
  @ApiProperty({ example: '66666666-6666-4666-8666-666666666666' })
  id: string;

  @ApiProperty({ type: () => InviteCohortDto, nullable: true })
  cohort: InviteCohortDto | null;

  @ApiProperty({ type: () => InviteCohortTrackDto, nullable: true })
  cohortTrack: InviteCohortTrackDto | null;

  @ApiProperty({ type: () => InviteTrackDto, nullable: true })
  track: InviteTrackDto | null;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    nullable: true,
  })
  cohortRole: CohortRole | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: InviteStatus, enumName: 'InviteStatus' })
  status: InviteStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-29T12:00:00.000Z',
    description:
      'When the offer lapses. Not a deadline on the user, but the boundary at which this endpoint starts answering 403.',
  })
  expiresAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'Guest invites only; null otherwise. When the access being offered ' +
      'ends — the decision screen should say so before anyone accepts, since ' +
      'a guest is agreeing to a visit rather than a place.',
  })
  guestAccessExpiresAt: Date | null;

  @ApiProperty({ type: () => InvitedByDto })
  invitedBy: InvitedByDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({ type: () => InviteInviteeDto })
  user: InviteInviteeDto;
}
