import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';

/**
 * In the body rather than the query string: request URLs are logged, and the
 * token is what makes the link work.
 */
export class InvitePreviewRequestDto {
  /**
   * The `token` from the invite link, exactly as it arrived.
   * @example hFiA6EvJBOTvjt53b6SuvRAOCUiWl7umU4OWZl08WnU
   */
  // Checked bottom-up, and only the first failure is reported: emptiness
  // first, or a missing token is described as too long.
  @MaxLength(256)
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class InvitePreviewCohortDto {
  /** @example "Product Design 2026" */
  name: string;

  /** @example PD26 */
  code: string;

  /** @example 2026-09-01 */
  @ApiPropertyOptional()
  startDate: string | null;

  /** @example 2027-06-30 */
  @ApiPropertyOptional()
  endDate: string | null;
}

export class InvitePreviewTrackDto {
  /** @example "Product Design" */
  name: string;

  /** @example PD */
  code: string;
}

export class InvitePreviewInviterDto {
  /** @example Jerry */
  @ApiPropertyOptional()
  firstName: string | null;

  /** @example Smith */
  @ApiPropertyOptional()
  lastName: string | null;
}

/**
 * What the invitation screen shows before sign-in. Deliberately carries no
 * ids: it is public to whoever holds the link, and nothing in it is meant to
 * be acted on — accepting still takes a Google sign-in as the invited address.
 */
export class InvitePreviewResponseDto {
  /**
   * The address the invite was sent to. Show it beside "Continue with Google":
   * signing in with any other account is refused with invite_required.
   * @example ada@campus.local
   */
  email: string;

  /** Null for an admin invite, which joins no cohort. */
  cohort: InvitePreviewCohortDto | null;

  /** Set for students; null for every other role. */
  track: InvitePreviewTrackDto | null;

  /** Null for an admin invite — show systemRole instead. */
  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    nullable: true,
  })
  cohortRole: CohortRole | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  invitedBy: InvitePreviewInviterDto;

  /**
   * When the link stops working.
   * @example 2026-10-07T12:00:00.000Z
   */
  expiresAt: Date;

  /** Guests only: when the visit being offered ends. Say so before they accept. */
  @ApiPropertyOptional({ example: null })
  guestAccessExpiresAt: Date | null;
}
