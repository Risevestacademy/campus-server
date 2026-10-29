import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';

/**
 * A day, read as midnight UTC, or an instant that says which zone it is in.
 * A timestamp with no zone would be read in whatever zone the server runs
 * in, so it is refused rather than guessed at — and so are the ISO 8601
 * forms a `Date` cannot read, a week (`2027-W48-1`) or an ordinal day
 * (`2027-335`), which would otherwise pass as valid and fail at the write.
 */
const DATE_OR_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Which of an entry's five subjects it names. Exactly one is set on every
 * row and every request — the database insists on it for rows
 * (`space_memberships_one_subject`) and the service on requests, so both
 * kinds of caller are held to the same rule.
 */
export enum SpaceMembershipSubjectType {
  User = 'user',
  CohortTrack = 'cohort_track',
  CohortRole = 'cohort_role',
  SystemRole = 'system_role',
  MentorshipGroup = 'mentorship_group',
}

export class SpaceIdParamDto {
  @ApiProperty({ example: '55555555-5555-4555-8555-555555555555' })
  @IsUUID()
  id: string;
}

/** The `:id` and `:membershipId` of the route that ends one grant. */
export class SpaceMembershipParamDto {
  @ApiProperty({ example: '55555555-5555-4555-8555-555555555555' })
  @IsUUID()
  id: string;

  @ApiProperty({ example: '66666666-6666-4666-8666-666666666666' })
  @IsUUID()
  membershipId: string;
}

/**
 * An entry on a designated space's list: one person, everybody on one of a
 * cohort's tracks, everybody holding a cohort role, everybody holding a
 * system role, or everybody in a mentorship group, optionally until a date.
 * That it names exactly one is a rule across the whole request rather than
 * any one field, so it is checked by the service, not here: a request naming
 * two or none is a 400 either way, and this way there is one answer to it
 * rather than two.
 */
export class GrantSpaceMembershipDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description:
      'Give access to this one person. Exactly one of `userId`, ' +
      '`cohortTrackId`, `cohortRole`, `systemRole` and `mentorshipGroupId` ' +
      'is required: an entry names one subject, never two and never none.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-4333-8333-333333333333',
    description:
      'Give access to everybody on this cohort track — a track a cohort ' +
      'runs, as named by `cohort_tracks.id`. Exactly one subject is ' +
      'required.',
  })
  @IsOptional()
  @IsUUID()
  cohortTrackId?: string;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    description:
      'Give access to everybody holding this role, in whichever cohort ' +
      'they walk the campus as. Exactly one subject is required.',
  })
  @IsOptional()
  @IsEnum(CohortRole)
  cohortRole?: CohortRole;

  @ApiPropertyOptional({
    enum: SystemRole,
    enumName: 'SystemRole',
    description:
      'Give access to everybody holding this system role. Admins enter ' +
      'every space anyway, so this matters for any other role. Exactly ' +
      'one subject is required.',
  })
  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '77777777-7777-4777-8777-777777777777',
    description:
      'Give access to this mentorship group: its students and its mentor, ' +
      'in the group’s own cohort. Exactly one subject is required.',
  })
  @IsOptional()
  @IsUUID()
  mentorshipGroupId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-12-01T00:00:00.000Z',
    description:
      'When access ends, which has to be in the future. A bare date ' +
      '(`2026-12-01`) is midnight UTC; a timestamp must carry its zone. ' +
      'Left out, access has no end until an admin ends it.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'validTo must be a date or a timestamp with a zone',
  })
  validTo?: string;
}

/** One grant, as the routes answer with it. */
export class SpaceMembershipSubjectDto {
  @ApiProperty({
    enum: SpaceMembershipSubjectType,
    enumName: 'SpaceMembershipSubjectType',
  })
  type: SpaceMembershipSubjectType;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Present when the grant is to a person.',
  })
  userId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'email',
    example: 'ada@campus.local',
    description: 'Present when the grant is to a person.',
  })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Ada L.',
    description: 'What they go by, or null if they have not chosen one.',
  })
  displayName?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-4333-8333-333333333333',
    description: 'Present when the grant is to a track.',
  })
  cohortTrackId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Frontend',
    description: 'Present when the grant is to a track.',
  })
  trackName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'FE',
    description: 'Present when the grant is to a track.',
  })
  trackCode?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '44444444-4444-4444-8444-444444444444',
    description:
      'The cohort behind it: the one whose track runs it, or the one the ' +
      'mentorship group belongs to.',
  })
  cohortId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cohort 1',
    description:
      'The cohort behind it: the one whose track runs it, or the one the ' +
      'mentorship group belongs to.',
  })
  cohortName?: string | null;

  @ApiPropertyOptional({
    enum: CohortRole,
    enumName: 'CohortRole',
    description: 'Present when the entry names a cohort role.',
  })
  cohortRole?: CohortRole;

  @ApiPropertyOptional({
    enum: SystemRole,
    enumName: 'SystemRole',
    description: 'Present when the entry names a system role.',
  })
  systemRole?: SystemRole;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '77777777-7777-4777-8777-777777777777',
    description: 'Present when the grant is to a mentorship group.',
  })
  mentorshipGroupId?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'The Ravens',
    description: 'Present when the grant is to a mentorship group.',
  })
  groupName?: string;
}

export class SpaceMembershipResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '66666666-6666-4666-8666-666666666666',
    description:
      'The grant’s own row. Ending access keeps the row, so this is what a ' +
      'grant is known by for good.',
  })
  id: string;

  @ApiProperty({
    format: 'uuid',
    example: '55555555-5555-4555-8555-555555555555',
  })
  spaceId: string;

  @ApiProperty({ type: SpaceMembershipSubjectDto })
  subject: SpaceMembershipSubjectDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The admin who granted it. Null only for a grant written without one: ' +
      'a seed, a sync.',
  })
  grantedBy: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the grant started counting.',
  })
  validFrom: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it stopped, or null while it has no end.',
  })
  validTo: Date | null;

  @ApiProperty({
    description:
      'Whether it counts right now: started, and not yet ended. Read at ' +
      'the moment of the request, not stored.',
  })
  live: boolean;
}
