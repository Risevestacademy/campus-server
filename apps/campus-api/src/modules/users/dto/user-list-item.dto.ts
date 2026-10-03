import { ApiProperty } from '@nestjs/swagger';

import { CohortRole, StudentStatus } from '../../cohorts/schema.js';
import { SystemRole, UserStatus } from '../schema.js';

export class UserMembershipCohortDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  id: string;

  @ApiProperty({ example: 'Product Design 2026' })
  name: string;

  @ApiProperty({ example: 'PD26' })
  code: string;
}

export class UserMembershipTrackDto {
  @ApiProperty({ example: '55555555-5555-4555-8555-555555555555' })
  id: string;

  @ApiProperty({ example: 'Product Design' })
  name: string;

  @ApiProperty({ example: 'PD' })
  code: string;
}

/** One live place on a roster, labelled so a table can show it as it is. */
export class UserMembershipDto {
  @ApiProperty({ type: () => UserMembershipCohortDto })
  cohort: UserMembershipCohortDto;

  @ApiProperty({
    type: () => UserMembershipTrackDto,
    nullable: true,
    description: 'Set for students; null for every other role.',
  })
  track: UserMembershipTrackDto | null;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  @ApiProperty({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
    description: 'Students only; null for every other role.',
  })
  status: StudentStatus | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  joinedAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Guests only: when the visit ends.',
  })
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
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({ example: 'ada@campus.local' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ada' })
  firstName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Lovelace' })
  lastName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Ada Lovelace' })
  displayName: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-01T08:15:00.000Z',
    description: 'Null for an account that has never signed in.',
  })
  lastLoginAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: () => [UserMembershipDto],
    description:
      'Every cohort this person may enter now, most recently joined first. ' +
      'All of them, whatever the filters: a filter chooses who is listed, ' +
      'not how much of them is shown. Empty for somebody with no live ' +
      'membership — an admin with no cohort, or a member who has left.',
  })
  memberships: UserMembershipDto[];
}
