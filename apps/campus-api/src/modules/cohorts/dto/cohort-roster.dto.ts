import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { UserStatus } from '../../users/schema.js';
import { CohortRole, StudentStatus } from '../schema.js';

/**
 * Whether a membership still counts. `live` is the rule sign-in uses: not
 * left, a student still active, a guest whose visit has not ended. `ended`
 * is everything else that has a row.
 */
export enum MembershipState {
  Live = 'live',
  Ended = 'ended',
}

/** Which memberships a roster lists. */
export enum RosterScope {
  Live = 'live',
  Ended = 'ended',
  All = 'all',
}

/**
 * Pagination plus the filters, every one optional and all combined with AND.
 */
export class ListRosterQueryDto extends PaginationQueryDto {
  /**
   * `live` (the default) for the people in the cohort now; `ended` for those
   * who left, were dismissed, withdrew, deferred, graduated, or whose guest
   * visit is over; `all` for both.
   */
  @ApiPropertyOptional({
    enum: RosterScope,
    enumName: 'RosterScope',
    default: RosterScope.Live,
  })
  @IsOptional()
  @IsEnum(RosterScope)
  state: RosterScope = RosterScope.Live;

  @ApiPropertyOptional({ enum: CohortRole, enumName: 'CohortRole' })
  @IsOptional()
  @IsEnum(CohortRole)
  role?: CohortRole;

  /**
   * Members on this track: its students, and any staff or guest who was placed
   * on it. Add `role=student` for the students alone.
   * @example 33333333-3333-4333-8333-333333333333
   */
  @IsOptional()
  @IsUUID()
  trackId?: string;

  /**
   * Students with this status. Anything but `active` is an ended membership, so
   * combine it with `state=ended` or `state=all`.
   */
  @ApiPropertyOptional({ enum: StudentStatus, enumName: 'StudentStatus' })
  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;
}

export class RosterUserDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /** @example ada@campus.local */
  email: string;

  /** @example Ada */
  firstName: string | null;

  /** @example Lovelace */
  lastName: string | null;

  /** @example "Ada L." */
  displayName: string | null;

  @ApiProperty({ example: null })
  avatarUrl: string | null;

  /**
   * The account’s own status. A suspended account keeps its place on the roster
   * but cannot sign in.
   */
  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;
}

export class RosterTrackDto {
  /** @example 33333333-3333-4333-8333-333333333333 */
  id: string;

  /** @example "Software Engineering" */
  name: string;

  /** @example SE */
  code: string;
}

/** One membership of the cohort, with the person who holds it. */
export class RosterMemberDto {
  /**
   * The membership, not the person: one per person per cohort.
   * @example 77777777-7777-4777-8777-777777777777
   */
  id: string;

  user: RosterUserDto;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  /**
   * Always set for a student. Staff and guests have one only when they were
   * placed on a track; otherwise null.
   */
  track: RosterTrackDto | null;

  /** Students only; null for every other role. */
  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
  })
  status: StudentStatus | null;

  /**
   * Whether the membership counts now, read against the clock rather than off a
   * column: a guest whose visit ended a minute ago is `ended` here.
   */
  @ApiProperty({ enum: MembershipState, enumName: 'MembershipState' })
  state: MembershipState;

  /** Why a dismissed student was dismissed. Null otherwise. */
  @ApiProperty({ example: null })
  dismissalReason: string | null;

  /** @example 2026-09-22T12:00:00.000Z */
  joinedAt: Date;

  leftAt: Date | null;

  /** Guests only: when the visit ends. */
  accessExpiresAt: Date | null;
}
