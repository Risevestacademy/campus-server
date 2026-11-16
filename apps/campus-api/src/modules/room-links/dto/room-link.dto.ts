import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { ROOM_LINK_CODE } from '../room-link-code.js';
import { RoomLinkAudience } from '../schema.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RoomLinkSpaceParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  @IsUUID()
  spaceId: string;
}

export class RoomLinkCodeParamDto {
  /** @example k3F9xQ2pLm */
  @Matches(ROOM_LINK_CODE)
  code: string;
}

export class CreateRoomLinkDto {
  /**
   * The event the link is for.
   * @example "Design review"
   */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  title: string;

  /** Whose event it is: the students expected at it. Defaults to the whole cohort. */
  @ApiPropertyOptional({
    enum: RoomLinkAudience,
    default: RoomLinkAudience.Cohort,
  })
  @IsOptional()
  @IsEnum(RoomLinkAudience)
  audience?: RoomLinkAudience;

  /**
   * The cohort-track, for `cohort-track`.
   * @example 44444444-4444-4444-8444-444444444444
   */
  @IsOptional()
  @IsUUID()
  cohortTrackId?: string;

  /**
   * The pod, for `mentorship-group`.
   * @example 55555555-5555-4555-8555-555555555555
   */
  @IsOptional()
  @IsUUID()
  mentorshipGroupId?: string;
}

/** A link to a space in one cohort's campus, made for one event. */
export class RoomLinkDto {
  /** @example k3F9xQ2pLm */
  code: string;

  /** @example https://campus.example.com/join/k3F9xQ2pLm */
  url: string;

  /** @example "Design review" */
  title: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  spaceId: string;

  /**
   * The space's key, as world names it.
   * @example pod-a
   */
  spaceKey: string;

  /** @example "Pod A" */
  spaceName: string;

  @ApiProperty({ enum: RoomLinkAudience })
  audience: RoomLinkAudience;

  /** Set for a `cohort-track` link. */
  cohortTrackId: string | null;

  /** Set for a `mentorship-group` link. */
  mentorshipGroupId: string | null;

  /**
   * When the run going on now, else the next one, starts, as synced from the
   * organiser's Google Calendar; null when none is coming. The link lets
   * people in from ten minutes before.
   * @example 2026-11-05T10:00:00.000Z
   */
  startsAt: Date | null;

  /** @example 2026-11-05T11:00:00.000Z */
  endsAt: Date | null;

  /** @example 2026-11-03T09:00:00.000Z */
  createdAt: Date;
}

/** A room link as entering it left it. */
export class RoomLinkEntryDto extends RoomLinkDto {
  /**
   * Whether world will let the caller into the space now: a run is open
   * (from ten minutes before it starts until it ends), or the caller is an
   * admin. When false, walk there anyway; a closed door can still be asked.
   * @example true
   */
  admitted: boolean;
}

/** Where a room link leads, without its own URL: what a calendar event shows. */
export class RoomLinkTargetDto {
  /** @example k3F9xQ2pLm */
  code: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  spaceId: string;

  /**
   * The space's key, as world names it.
   * @example pod-a
   */
  spaceKey: string;

  /** @example "Pod A" */
  spaceName: string;

  /**
   * The event the link was made for.
   * @example "Design review"
   */
  title: string;
}
