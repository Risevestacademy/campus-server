import {
  EVENT_RESPONSES,
  type CalendarEventDto,
  type EventResponse,
} from './dto/calendar-events.dto.js';

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
}

/** The fields of a Calendar API event that campus asks for. */
export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export const GOOGLE_EVENT_FIELDS =
  'nextPageToken,items(id,status,summary,location,htmlLink,hangoutLink,start,end,attendees(self,responseStatus))';

/** None for a cancelled event, or one missing what campus shows. */
export function toCalendarEvent(item: GoogleEvent): CalendarEventDto[] {
  const start = item.start?.dateTime ?? item.start?.date;
  const end = item.end?.dateTime ?? item.end?.date;
  if (item.status === 'cancelled' || !item.id || !start || !end) {
    return [];
  }
  const response = item.attendees?.find((a) => a.self)?.responseStatus;
  return [
    {
      id: item.id,
      title: item.summary ?? null,
      start,
      end,
      allDay: !item.start?.dateTime,
      status: item.status === 'tentative' ? 'tentative' : 'confirmed',
      response: isEventResponse(response) ? response : null,
      location: item.location ?? null,
      meetingUrl: item.hangoutLink ?? null,
      url: item.htmlLink ?? null,
    },
  ];
}

function isEventResponse(value: unknown): value is EventResponse {
  return (EVENT_RESPONSES as readonly unknown[]).includes(value);
}
