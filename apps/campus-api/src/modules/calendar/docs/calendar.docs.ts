import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../../../shared/dto/api-error-response.dto.js';
import { CALENDAR_CONNECT_OUTCOMES } from '../calendar-return.js';
import { CalendarEventsDto } from '../dto/calendar-events.dto.js';

const NOT_CONFIGURED = ApiNotFoundResponse({
  type: ApiErrorResponseDto,
  description: 'Google Calendar is switched off on this deployment.',
});

const NO_SESSION = ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'No full-access session.',
});

const GOOGLE_DOWN = ApiServiceUnavailableResponse({
  type: ApiErrorResponseDto,
  description: 'Google did not answer in time. Worth trying again shortly.',
});

const OUTCOMES = CALENDAR_CONNECT_OUTCOMES.join(', ');

export function ApiConnectCalendar(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Connect my Google Calendar (web)',
      description:
        'Open as a top-level navigation with a live session cookie: refresh ' +
        'first if the access token is close to running out, since the ' +
        'callback needs the same session. Redirects to Google’s consent ' +
        'screen for read-only calendar access. The Google account must be ' +
        'the one the member signs in to campus with.',
    }),
    ApiResponse({
      status: 302,
      description: `To Google; on failure to APP_PUBLIC_URL/campus?calendar=<outcome>, where outcome is one of ${OUTCOMES}.`,
    }),
  );
}

export function ApiConnectCalendarCallback(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Complete connecting my Google Calendar (web)',
      description:
        'Where Google returns the member. Needs the session that started ' +
        'the connection. Every outcome is a redirect into the web app.',
    }),
    ApiResponse({
      status: 302,
      description: `To APP_PUBLIC_URL/campus?calendar=<outcome>, where outcome is one of ${OUTCOMES}.`,
    }),
  );
}

export function ApiConnectCalendarFromApp(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Connect my Google Calendar (native app)',
      description:
        'The app asks Google’s SDK for calendar access and posts the server ' +
        'auth code it receives. Replaces any calendar connection already ' +
        'held.',
    }),
    ApiNoContentResponse({ description: 'Connected.' }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        'INVALID_ARGUMENT, with `details.reason`: exchange_failed (Google ' +
        'did not accept the code), wrong_account (another Google account ' +
        'than the member signs in with), not_granted (calendar access ' +
        'unticked) or no_refresh_token (asked without offline access or ' +
        'force-refresh-token).',
    }),
    NO_SESSION,
    NOT_CONFIGURED,
    GOOGLE_DOWN,
  );
}

export function ApiCalendarEvents(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'My Google Calendar events',
      description:
        'Read from Google when asked, never stored here. Read-only: campus ' +
        'cannot create or change events. Without a connected calendar the ' +
        'answer is still 200, with `connected: false`.',
    }),
    ApiOkResponse({ type: CalendarEventsDto }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description:
        '`from` or `to` is not a date or a zoned timestamp, `to` is not ' +
        'after `from`, or they are more than 62 days apart.',
    }),
    NO_SESSION,
    NOT_CONFIGURED,
    GOOGLE_DOWN,
  );
}

export function ApiDisconnectCalendar(): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: 'Disconnect my Google Calendar',
      description:
        'Stops using the calendar access campus holds and revokes it at ' +
        'Google, which also takes campus off the member’s Google account ' +
        'connections. If Google does not confirm the revocation, campus keeps ' +
        'trying, unused, until it does. Works while the calendar is switched ' +
        'off.',
    }),
    ApiNoContentResponse({ description: 'Forgotten, or there was none.' }),
    NO_SESSION,
  );
}
