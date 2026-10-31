import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
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
import { SPRITE_KEYS, type SpriteKey } from '@campus/session';

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
  /** @example 22222222-2222-4222-8222-222222222222 */
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
  /** @example Ada */
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string | null;

  /** @example Lovelace */
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string | null;

  /**
   * The name shown beside the avatar in the campus.
   * @example "Ada L."
   */
  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string | null;

  /**
   * Digits, with an optional leading + and spaces, hyphens or brackets between
   * them. Seen by the owner and admins only.
   * @example "+234 801 234 5678"
   */
  @Cleaned()
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9][0-9 ()-]{5,22}$/, {
    message: 'phone must be a phone number, like +234 801 234 5678',
  })
  phone?: string | null;

  @Cleaned()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  /**
   * The character they walk the campus as. Anybody in the campus with them sees
   * the change straight away.
   */
  @ApiPropertyOptional({ example: SPRITE_KEYS[0] })
  @Cleaned()
  @IsOptional()
  @IsIn(SPRITE_KEYS, {
    message: `spriteKey must be one of: ${SPRITE_KEYS.join(', ')}`,
  })
  spriteKey?: SpriteKey | null;
}

/** The caller's own profile: everything, since it is theirs. */
export class OwnProfileDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /**
   * The Google account they sign in with. Not editable.
   * @example ada@campus.local
   */
  email: string;

  /** @example Ada */
  firstName: string | null;

  /** @example Lovelace */
  lastName: string | null;

  /** @example "Ada L." */
  displayName: string | null;

  @ApiProperty({ example: null })
  phone: string | null;

  @ApiProperty({ example: null })
  bio: string | null;

  /**
   * The picture Google gave at first sign-in. Null when it gave none.
   * @example https://lh3.googleusercontent.com/a/example
   */
  avatarUrl: string | null;

  /**
   * The character they walk the campus as. Null when they have picked none, or
   * picked one that is no longer offered.
   */
  @ApiProperty({ example: null })
  spriteKey: SpriteKey | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  /** Every cohort they hold a live place in. */
  memberships: UserMembershipDto[];

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;
}

/** A place on a roster, as much of it as a profile card shows. */
export class ProfileCardMembershipDto {
  cohort: UserMembershipCohortDto;

  /** Set for students; null for every other role. */
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
  bio: string | null;

  @ApiProperty({ example: null })
  avatarUrl: string | null;

  /**
   * The character they walk the campus as. Null when they have picked none, or
   * picked one that is no longer offered.
   */
  @ApiProperty({ example: null })
  spriteKey: SpriteKey | null;

  /**
   * The cohorts the viewer shares with this person, most recently joined first.
   * An admin, and the person themselves, see every live one.
   */
  memberships: ProfileCardMembershipDto[];
}

/** One person in a cohort, as the sidebar draws them. */
export class CohortProfileDto {
  /** @example 22222222-2222-4222-8222-222222222222 */
  id: string;

  /** @example "Ada L." */
  displayName: string | null;

  /** Null when they have picked none, or picked one that is no longer offered. */
  @ApiProperty({ example: null })
  spriteKey: SpriteKey | null;
}
