import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

const DATE_OR_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export class CalendarEventsQueryDto {
  /**
   * Events that end after this. A bare date is midnight UTC. Left out, now.
   * @example 2026-10-26T00:00:00+01:00
   */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'from must be a date or a timestamp with a zone',
  })
  from?: string;

  /**
   * Events that start before this. At most 62 days after `from`. Left out, 7
   * days after `from`.
   * @example 2026-11-02T00:00:00+01:00
   */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'to must be a date or a timestamp with a zone',
  })
  to?: string;
}

export const EVENT_STATUSES = ['confirmed', 'tentative'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_RESPONSES = [
  'accepted',
  'tentative',
  'declined',
  'needsAction',
] as const;
export type EventResponse = (typeof EVENT_RESPONSES)[number];

export class CalendarEventDto {
  /** @example 7cbh8rpc10lrc0ckih9tafss99_20261027T090000Z */
  id!: string;

  /**
   * Null for an event with no title.
   * @example "Backend standup"
   */
  title!: string | null;

  /**
   * A timestamp with the zone Google gave it, or a date (`2026-10-27`) for an
   * all-day event.
   * @example 2026-10-27T10:00:00+01:00
   */
  start!: string;

  /**
   * Like `start`. For an all-day event, the day after the last one.
   * @example 2026-10-27T10:30:00+01:00
   */
  end!: string;

  /** @example false */
  allDay!: boolean;

  /** @example confirmed */
  @ApiProperty({ enum: EVENT_STATUSES })
  status!: EventStatus;

  /**
   * The member’s answer to the invitation. Null when they are the only person
   * on it.
   * @example accepted
   */
  @ApiProperty({ enum: EVENT_RESPONSES, nullable: true })
  response!: EventResponse | null;

  /** @example "Room 2" */
  location!: string | null;

  /** @example https://meet.google.com/abc-defg-hij */
  meetingUrl!: string | null;

  /**
   * The event in Google Calendar.
   * @example https://www.google.com/calendar/event?eid=N2NiaDhycGMxMGxy
   */
  url!: string | null;
}

export class CalendarEventsDto {
  /**
   * False when the member has not connected their calendar, or Google has
   * withdrawn access: offer GET /v1/calendar/connect (a native app: POST
   * /v1/calendar/connect).
   * @example true
   */
  connected!: boolean;

  /**
   * From the member’s primary calendar, soonest first, recurring events as one
   * entry per occurrence. Cancelled events are left out.
   */
  events!: CalendarEventDto[];

  /**
   * True when the window held more than the 1,000 events campus reads: `events`
   * are the first 1,000. Ask for a shorter window.
   * @example false
   */
  truncated!: boolean;
}
