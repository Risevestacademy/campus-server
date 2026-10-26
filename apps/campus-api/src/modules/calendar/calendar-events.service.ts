import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { AccessTokenCache } from './access-token-cache.js';
import {
  CalendarGrantsService,
  type CalendarGrant,
} from './calendar-grants.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import { CalendarUnavailableError } from './calendar.exceptions.js';
import type {
  CalendarEventDto,
  CalendarEventsDto,
  CalendarEventsQueryDto,
} from './dto/calendar-events.dto.js';
import {
  CALENDAR_FETCH,
  GrantWithdrawnError,
} from './google-calendar.client.js';
import {
  GOOGLE_EVENT_FIELDS,
  toCalendarEvent,
  type GoogleEvent,
} from './google-event.js';

const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const PAGE_SIZE = 250;
export const MAX_PAGES = 4;
/** One read, however many requests it takes: the refresh and every page. */
export const READ_BUDGET_MS = 20_000;

const DAY_MS = 86_400_000;
export const DEFAULT_SPAN_DAYS = 7;
export const MAX_SPAN_DAYS = 62;

const NOT_CONNECTED: CalendarEventsDto = {
  connected: false,
  events: [],
  truncated: false,
};

interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

class AccessTokenRejected extends Error {}

/** A member's events, read from Google when asked and never stored. */
@Injectable()
export class CalendarEventsService {
  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly tokens: AccessTokenCache,
    private readonly revocations: CalendarRevocationService,
    @Inject(CALENDAR_FETCH) private readonly fetch: typeof globalThis.fetch,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarEventsService.name);
  }

  async events(
    userId: string,
    query: CalendarEventsQueryDto,
  ): Promise<CalendarEventsDto> {
    // First, so the sweep's timing does not depend on who is asking.
    this.revocations.sweepIfDue();
    const grant = await this.grants.find(userId);
    const { from, to } = window(query);
    if (!grant) {
      return NOT_CONNECTED;
    }
    try {
      const signal = AbortSignal.timeout(READ_BUDGET_MS);
      return { connected: true, ...(await this.read(grant, from, to, signal)) };
    } catch (err) {
      if (!(err instanceof GrantWithdrawnError)) {
        throw err;
      }
      this.tokens.evict(userId);
      await this.grants.forget(grant);
      this.logger.info({ userId }, 'calendar access withdrawn at google');
      return NOT_CONNECTED;
    }
  }

  /** With a fresh access token once, if Google rejects the cached one. */
  private async read(
    grant: CalendarGrant,
    from: Date,
    to: Date,
    signal: AbortSignal,
  ): Promise<{ events: CalendarEventDto[]; truncated: boolean }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const token = await this.tokens.get(grant, signal);
        return await this.list(token, from, to, signal);
      } catch (err) {
        if (!(err instanceof AccessTokenRejected)) {
          throw err;
        }
        this.tokens.evict(grant.userId);
        if (attempt === 2) {
          this.logger.error(
            { userId: grant.userId },
            'google rejected a fresh access token',
          );
          throw new CalendarUnavailableError();
        }
      }
    }
  }

  private async list(
    token: string,
    from: Date,
    to: Date,
    signal: AbortSignal,
  ): Promise<{ events: CalendarEventDto[]; truncated: boolean }> {
    const events: CalendarEventDto[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(EVENTS_URL);
      url.search = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(PAGE_SIZE),
        fields: GOOGLE_EVENT_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const body = await this.get(url, token, signal);
      events.push(...(body.items ?? []).flatMap(toCalendarEvent));
      pageToken = body.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return { events, truncated: pageToken !== undefined };
  }

  private async get(
    url: URL,
    token: string,
    signal: AbortSignal,
  ): Promise<GoogleEventList> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      this.logger.error({ err }, 'google calendar unreachable');
      throw new CalendarUnavailableError();
    }

    if (res.ok) {
      try {
        return (await res.json()) as GoogleEventList;
      } catch (err) {
        this.logger.error({ err }, 'google calendar answered unreadably');
        throw new CalendarUnavailableError();
      }
    }
    if (res.status === 401) {
      throw new AccessTokenRejected();
    }
    const text = await res.text().catch(() => '');
    if (
      res.status === 403 &&
      /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(text)
    ) {
      throw new GrantWithdrawnError();
    }
    this.logger.error(
      { status: res.status, body: text.slice(0, 500) },
      'google calendar refused a read',
    );
    throw new CalendarUnavailableError();
  }
}

function window(query: CalendarEventsQueryDto): { from: Date; to: Date } {
  const from = query.from ? new Date(query.from) : new Date();
  const to = query.to
    ? new Date(query.to)
    : new Date(from.getTime() + DEFAULT_SPAN_DAYS * DAY_MS);
  if (to.getTime() <= from.getTime()) {
    throw new InvalidArgumentException('to must be after from', {
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) {
    throw new InvalidArgumentException(
      `from and to may be at most ${MAX_SPAN_DAYS} days apart`,
      { from: from.toISOString(), to: to.toISOString() },
    );
  }
  return { from, to };
}
