import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * Which of a grant's two subjects it names. Exactly one is set on every row
 * and every request — the database insists on it for rows
 * (`space_memberships_one_subject`) and the service on requests, so both
 * kinds of caller are held to the same rule.
 */
export enum SpaceMembershipSubjectType {
  User = 'user',
  CohortTrack = 'cohort_track',
}

export class SpaceIdParamDto {
  @ApiProperty({ example: '55555555-5555-4555-8555-555555555555' })
  @IsUUID()
  id: string;
}

export class MembershipIdParamDto {
  @ApiProperty({ example: '66666666-6666-4666-8666-666666666666' })
  @IsUUID()
  membershipId: string;
}

/**
 * A grant of access to a space: to one person, or to everybody on one of
 * the cohort's tracks, and optionally until a date. Which of the two it is
 * to is a rule across the whole request rather than any one field, so it is
 * checked by the service, not here: a request with both or neither is a 400
 * either way, and this way there is one answer to it rather than two.
 */
export class GrantSpaceMembershipDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description:
      'Give access to this one person. Exactly one of `userId` and ' +
      '`cohortTrackId` is required: a grant is to a person or to a track, ' +
      'never both and never neither.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-4333-8333-333333333333',
    description:
      'Give access to everybody on this cohort track — a track a cohort ' +
      'runs, as named by `cohort_tracks.id`. Exactly one of `userId` and ' +
      '`cohortTrackId` is required.',
  })
  @IsOptional()
  @IsUUID()
  cohortTrackId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-12-01T00:00:00.000Z',
    description:
      'When access ends: an ISO 8601 instant, which has to be in the ' +
      'future. Left out, access has no end until an admin ends it.',
  })
  @IsOptional()
  @IsISO8601()
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
      'The cohort whose track runs it, when the grant is to a track.',
  })
  cohortId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cohort 1',
    description:
      'The cohort whose track runs it, when the grant is to a track.',
  })
  cohortName?: string | null;
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
