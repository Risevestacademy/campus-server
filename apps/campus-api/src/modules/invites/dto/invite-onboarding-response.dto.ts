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
  /** @example 11111111-1111-4111-8111-111111111111 */
  id: string;

  /** @example "Cohort 1" */
  name: string;

  /** @example C1 */
  code: string;

  /** @example 2026-09-01 */
  @ApiPropertyOptional()
  startDate: string | null;

  /** @example 2027-06-30 */
  @ApiPropertyOptional()
  endDate: string | null;

  @ApiProperty({ enum: CohortStatus, enumName: 'CohortStatus' })
  status: CohortStatus;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-09-22T12:00:00.000Z */
  updatedAt: Date;
}

/** The COHORT_TRACKS link row the invite points at, not the track itself. */
export class InviteCohortTrackDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  trackId: string;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;
}

export class InviteTrackDto {
  /** @example 33333333-3333-4333-8333-333333333333 */
  id: string;

  /** @example "Software Engineering" */
  name: string;

  /** @example SE */
  code: string;

  /** @example "Backend and infra" */
  @ApiPropertyOptional()
  description: string | null;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-09-22T12:00:00.000Z */
  updatedAt: Date;
}

/**
 * Whoever sent the offer. Named for the field rather than the role:
 * INVITES.INVITED_BY is all the row records, so it does not assert they still
 * hold that role today.
 */
export class InvitedByDto {
  /** @example 44444444-4444-4444-8444-444444444444 */
  id: string;

  /** @example Ada */
  @ApiPropertyOptional()
  firstName: string | null;

  /** @example Lovelace */
  @ApiPropertyOptional()
  lastName: string | null;
}

/** The signed-in account, as read from the USERS row on this request. */
export class InviteInviteeDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  id: string;

  /** @example new.student@campus.local */
  email: string;

  /** @example New */
  @ApiPropertyOptional()
  firstName: string | null;

  /** @example Student */
  @ApiPropertyOptional()
  lastName: string | null;

  /** @example "New Student" */
  @ApiPropertyOptional()
  displayName: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;
}

export class InviteOnboardingResponseDto {
  /** @example 66666666-6666-4666-8666-666666666666 */
  id: string;

  cohort: InviteCohortDto | null;

  cohortTrack: InviteCohortTrackDto | null;

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

  /**
   * When the offer lapses. Not a deadline on the user, but the boundary at
   * which this endpoint starts answering 403.
   * @example 2026-09-29T12:00:00.000Z
   */
  expiresAt: Date;

  /**
   * Guest invites only; null otherwise. When the access being offered ends —
   * the decision screen should say so before anyone accepts, since a guest is
   * agreeing to a visit rather than a place.
   */
  @ApiPropertyOptional({ example: null })
  guestAccessExpiresAt: Date | null;

  /**
   * When the invitee flagged a mistake on this invite with POST
   * /v1/invites/flag; null if they have not. An invite takes one flag, so once
   * this is set the button has nothing left to do. Accepting works either way.
   */
  @ApiPropertyOptional({ example: null })
  flaggedAt: Date | null;

  invitedBy: InvitedByDto;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  user: InviteInviteeDto;
}
