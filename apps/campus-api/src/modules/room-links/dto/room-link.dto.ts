import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { ROOM_LINK_CODE } from '../room-link-code.js';

const ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Left out is fine; null is not a time, so it is checked and refused. */
const present = (_: object, value: unknown) => value !== undefined;

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

/**
 * When the event runs: both times, or neither for a link with no window.
 * The window must end after it starts.
 */
export class RoomLinkWindowDto {
  /** @example 2026-11-05T10:00:00.000Z */
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf(present)
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT, {
    message: 'startsAt must be a timestamp with a zone',
  })
  startsAt?: string;

  /** @example 2026-11-05T11:00:00.000Z */
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf(present)
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT, { message: 'endsAt must be a timestamp with a zone' })
  endsAt?: string;
}

export class CreateRoomLinkDto extends RoomLinkWindowDto {
  /**
   * The event the link is for.
   * @example "Design review"
   */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  title: string;
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

  /**
   * When the event starts; null for a link with no window. The link lets
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
   * Whether world will let the caller into the space now: the window is open
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
