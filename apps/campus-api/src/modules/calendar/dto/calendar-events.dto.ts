import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

const DATE_OR_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export class CalendarEventsQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-26T00:00:00+01:00',
    description:
      'Events that end after this. A bare date is midnight UTC. Left out, now.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'from must be a date or a timestamp with a zone',
  })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-11-02T00:00:00+01:00',
    description:
      'Events that start before this. At most 62 days after `from`. Left ' +
      'out, 7 days after `from`.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(DATE_OR_ZONED_INSTANT, {
    message: 'to must be a date or a timestamp with a zone',
  })
  to?: string;
}

export const EVENT_RESPONSES = [
  'accepted',
  'tentative',
  'declined',
  'needsAction',
] as const;
export type EventResponse = (typeof EVENT_RESPONSES)[number];

export class CalendarEventDto {
  @ApiProperty({ example: '7cbh8rpc10lrc0ckih9tafss99_20261027T090000Z' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Backend standup',
    description: 'Null for an event with no title.',
  })
  title!: string | null;

  @ApiProperty({
    example: '2026-10-27T10:00:00+01:00',
    description:
      'A timestamp with the zone Google gave it, or a date (`2026-10-27`) ' +
      'for an all-day event.',
  })
  start!: string;

  @ApiProperty({
    example: '2026-10-27T10:30:00+01:00',
    description:
      'Like `start`. For an all-day event, the day after the last one.',
  })
  end!: string;

  @ApiProperty({ example: false })
  allDay!: boolean;

  @ApiProperty({ enum: ['confirmed', 'tentative'], example: 'confirmed' })
  status!: 'confirmed' | 'tentative';

  @ApiProperty({
    enum: EVENT_RESPONSES,
    nullable: true,
    example: 'accepted',
    description:
      'The member’s answer to the invitation. Null when they are the only ' +
      'person on it.',
  })
  response!: EventResponse | null;

  @ApiProperty({ type: String, nullable: true, example: 'Room 2' })
  location!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://meet.google.com/abc-defg-hij',
  })
  meetingUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://www.google.com/calendar/event?eid=N2NiaDhycGMxMGxy',
    description: 'The event in Google Calendar.',
  })
  url!: string | null;
}

export class CalendarEventsDto {
  @ApiProperty({
    example: true,
    description:
      'False when the member has not connected their calendar, or Google ' +
      'has withdrawn access: offer GET /v1/calendar/connect (a native app: ' +
      'POST /v1/calendar/connect).',
  })
  connected!: boolean;

  @ApiProperty({
    type: [CalendarEventDto],
    description:
      'From the member’s primary calendar, soonest first, recurring events ' +
      'as one entry per occurrence. Cancelled events are left out.',
  })
  events!: CalendarEventDto[];
}
