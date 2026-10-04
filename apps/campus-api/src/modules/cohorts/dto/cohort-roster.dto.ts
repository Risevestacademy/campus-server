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
  @ApiPropertyOptional({
    enum: RosterScope,
    enumName: 'RosterScope',
    default: RosterScope.Live,
    description:
      '`live` (the default) for the people in the cohort now; `ended` for ' +
      'those who left, were dismissed, withdrew, deferred, graduated, or ' +
      'whose guest visit is over; `all` for both.',
  })
  @IsOptional()
  @IsEnum(RosterScope)
  state: RosterScope = RosterScope.Live;

  @ApiPropertyOptional({ enum: CohortRole, enumName: 'CohortRole' })
  @IsOptional()
  @IsEnum(CohortRole)
  role?: CohortRole;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-4333-8333-333333333333',
    description:
      'Members on this track. Only students are placed on a track, so this ' +
      'finds students.',
  })
  @IsOptional()
  @IsUUID()
  trackId?: string;

  @ApiPropertyOptional({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    description:
      'Students with this status. Anything but `active` is an ended ' +
      'membership, so combine it with `state=ended` or `state=all`.',
  })
  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;
}

export class RosterUserDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({ example: 'ada@campus.local' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ada' })
  firstName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Lovelace' })
  lastName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Ada L.' })
  displayName: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({
    enum: UserStatus,
    enumName: 'UserStatus',
    description:
      'The account’s own status. A suspended account keeps its place on ' +
      'the roster but cannot sign in.',
  })
  status: UserStatus;
}

export class RosterTrackDto {
  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  id: string;

  @ApiProperty({ example: 'Software Engineering' })
  name: string;

  @ApiProperty({ example: 'SE' })
  code: string;
}

/** One membership of the cohort, with the person who holds it. */
export class RosterMemberDto {
  @ApiProperty({
    example: '77777777-7777-4777-8777-777777777777',
    description: 'The membership, not the person: one per person per cohort.',
  })
  id: string;

  @ApiProperty({ type: () => RosterUserDto })
  user: RosterUserDto;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  @ApiProperty({
    type: () => RosterTrackDto,
    nullable: true,
    description: 'Set for students; null for every other role.',
  })
  track: RosterTrackDto | null;

  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
    description: 'Students only; null for every other role.',
  })
  status: StudentStatus | null;

  @ApiProperty({
    enum: MembershipState,
    enumName: 'MembershipState',
    description:
      'Whether the membership counts now, read against the clock rather ' +
      'than off a column: a guest whose visit ended a minute ago is ' +
      '`ended` here.',
  })
  state: MembershipState;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why a dismissed student was dismissed. Null otherwise.',
  })
  dismissalReason: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  joinedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  leftAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Guests only: when the visit ends.',
  })
  accessExpiresAt: Date | null;
}
