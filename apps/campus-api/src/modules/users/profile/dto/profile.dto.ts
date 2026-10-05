import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { CohortRole } from '../../../cohorts/schema.js';
import { SystemRole } from '../../schema.js';
import {
  UserMembershipCohortDto,
  UserMembershipDto,
  UserMembershipTrackDto,
} from '../../dto/user-list-item.dto.js';

/**
 * Trimmed, with an empty string read as "clear it". NUL goes too: Postgres
 * refuses it in text, which would be a 500 for a character nobody can see.
 */
function Cleaned(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const cleaned = value.replaceAll('\u0000', '').trim();
    return cleaned === '' ? null : cleaned;
  });
}

/** The `:id` of the routes about one user. */
export class UserIdParamDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  @IsUUID()
  id: string;
}

/**
 * A partial update of the caller's own profile. Leave a field out to keep
 * it; send `null` (or an empty string) to clear it.
 *
 * The address is not here: it is the Google account the person signs in
 * with, and changing it would change who they are.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Ada' })
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Lovelace' })
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Ada L.',
    description: 'The name shown beside the avatar in the campus.',
  })
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+234 801 234 5678',
    description:
      'Digits, with an optional leading + and spaces, hyphens or brackets ' +
      'between them. Seen by the owner and admins only.',
  })
  @Cleaned()
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9][0-9 ()-]{5,22}$/, {
    message: 'phone must be a phone number, like +234 801 234 5678',
  })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;
}

/** The caller's own profile: everything, since it is theirs. */
export class OwnProfileDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({
    example: 'ada@campus.local',
    description: 'The Google account they sign in with. Not editable.',
  })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ada' })
  firstName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Lovelace' })
  lastName: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Ada L.' })
  displayName: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  phone: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  bio: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://lh3.googleusercontent.com/a/example',
    description:
      'The picture Google gave at first sign-in. Null when it gave none.',
  })
  avatarUrl: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  spriteKey: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({
    type: () => [UserMembershipDto],
    description: 'Every cohort they hold a live place in.',
  })
  memberships: UserMembershipDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;
}

/** A place on a roster, as much of it as a profile card shows. */
export class ProfileCardMembershipDto {
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
}

/**
 * What one member sees of another. Named fields, so a column added to USERS
 * later is withheld until somebody decides it belongs on a card. The phone
 * number is not on it: that is for the owner and admins.
 */
export class ProfileCardDto {
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
  bio: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  spriteKey: string | null;

  @ApiProperty({
    type: () => [ProfileCardMembershipDto],
    description:
      'The cohorts the viewer shares with this person, most recently ' +
      'joined first. An admin, and the person themselves, see every live ' +
      'one.',
  })
  memberships: ProfileCardMembershipDto[];
}
