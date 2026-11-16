import { ApiProperty } from '@nestjs/swagger';

import { CohortRole, StudentStatus } from '../../cohorts/schema.js';
import { SystemRole, UserStatus } from '../schema.js';

export class UserMembershipCohortDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  id: string;

  /** @example "Product Design 2026" */
  name: string;

  /** @example PD26 */
  code: string;
}

export class UserMembershipTrackDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  id: string;

  /** @example "Product Design" */
  name: string;

  /** @example PD */
  code: string;
}

/**
 * One live place on a roster, labelled so a table can show it as it is.
 *
 * Live is a fact about the membership alone: not left, not dismissed, a
 * guest visit not yet over. Whether the account behind it may sign in is the
 * account's `status`, which this says nothing about.
 */
export class UserMembershipDto {
  cohort: UserMembershipCohortDto;

  /** Set for students; null for every other role. */
  track: UserMembershipTrackDto | null;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  /** Students only; null for every other role. */
  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
  })
  status: StudentStatus | null;

  /** @example 2026-09-22T12:00:00.000Z */
  joinedAt: Date;

  /** Guests only: when the visit ends. */
  @ApiProperty({ example: null })
  accessExpiresAt: Date | null;
}

/**
 * One row in the admin user list.
 *
 * Named fields rather than the USERS row: provider_id is the account's Google
 * subject and has no business in a table, and a column added later is
 * withheld until somebody decides it belongs here.
 */
export class UserListItemDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /** @example ada@campus.local */
  email: string;

  /** @example Ada */
  firstName: string | null;

  /** @example Lovelace */
  lastName: string | null;

  /** @example "Ada Lovelace" */
  displayName: string | null;

  @ApiProperty({ example: null })
  avatarUrl: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;

  /**
   * Null for an account that has never signed in.
   * @example 2026-10-01T08:15:00.000Z
   */
  lastLoginAt: Date | null;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /**
   * Every live place this person holds on a roster, most recently joined first.
   * All of them, whatever the filters: a filter chooses who is listed, not how
   * much of them is shown. Empty for somebody with no live membership — an
   * admin with no cohort, or a member who has left.

This is the roster, not
   * access. A suspended account keeps its memberships and is listed with them,
   * so an admin can see where the person belongs, but it cannot sign in: read
   * `status` for that.
   */
  memberships: UserMembershipDto[];
}
