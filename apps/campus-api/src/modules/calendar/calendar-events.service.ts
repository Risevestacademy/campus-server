import { ROOM_LINK_OPENS_EARLY_MS } from '@campus/space-access';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import type { RoomLinkTargetDto } from '../room-links/dto/room-link.dto.js';
import {
  RoomLinksService,
  type RoomLinkWindow,
} from '../room-links/room-links.service.js';
import { AccessTokenCache } from './access-token-cache.js';
import {
  CalendarGrantsService,
  type CalendarGrant,
} from './calendar-grants.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import {
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
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
import { extractRoomLinkCode } from './room-link.js';

const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const PAGE_SIZE = 250;
export const MAX_PAGES = 4;
/** One read, however many requests it takes: the refresh and every page. */
export const READ_BUDGET_MS = 20_000;
/** Somebody is waiting to walk in, so a slow Google leaves the window be. */
export const ENTRY_READ_BUDGET_MS = 3_000;
const ENTRY_EVENT_FIELDS =
  'items(status,start,end,location,description,organizer(self))';

const DAY_MS = 86_400_000;
export const DEFAULT_SPAN_DAYS = 7;
export const MAX_SPAN_DAYS = 62;

const NOT_CONNECTED: CalendarEventsDto = {
  connected: false,
  events: [],
  truncated: false,
};

interface EventsRead {
  events: CalendarEventDto[];
  /** The room link code found in each event, by index. */
  codes: (string | null)[];
  truncated: boolean;
}

interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

class AccessTokenRejected extends Error {}

/** A member's events, read from Google when asked and never stored. */
@Injectable()
export class CalendarEventsService {
  private readonly appUrl: string;

  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly tokens: AccessTokenCache,
    private readonly revocations: CalendarRevocationService,
    @Inject(CALENDAR_FETCH) private readonly fetch: typeof globalThis.fetch,
    @Inject(CONFIG) config: Env,
    private readonly roomLinks: RoomLinksService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarEventsService.name);
    this.appUrl = config.APP_PUBLIC_URL;
  }

  async events(
    user: AuthenticatedUser,
    query: CalendarEventsQueryDto,
  ): Promise<CalendarEventsDto> {
    const userId = user.id;
    // First, so the sweep's timing does not depend on who is asking.
    this.revocations.sweepIfDue();
    const grant = await this.grants.find(userId);
    const { from, to } = window(query);
    if (!grant) {
      return NOT_CONNECTED;
    }
    try {
      const signal = AbortSignal.timeout(READ_BUDGET_MS);
      const { events, codes, truncated } = await this.read(
        grant,
        from,
        to,
        signal,
      );
      await this.placeInRooms(user, events, codes);
      return { connected: true, events, truncated };
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

  /**
   * The maker's own event carrying this room link that runs now, or starts
   * within the link's early opening: its times. Null when there is none,
   * when the maker has not connected a calendar, or when Google does not
   * answer in time; the link's stored window then stands. Events somebody
   * else organised are left out, so an invitation cannot move a window.
   */
  async runningRoomLinkEvent(
    makerId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<RoomLinkWindow | null> {
    let grant: CalendarGrant | null;
    try {
      grant = await this.grants.find(makerId);
    } catch (err) {
      if (err instanceof CalendarNotConfiguredError) {
        return null;
      }
      throw err;
    }
    if (!grant) {
      return null;
    }
    try {
      const signal = AbortSignal.timeout(ENTRY_READ_BUDGET_MS);
      const items = await this.withToken(grant, signal, (token) =>
        this.running(token, now, signal),
      );
      for (const item of items) {
        const startsAt = item.start?.dateTime;
        const endsAt = item.end?.dateTime;
        if (
          item.status === 'cancelled' ||
          item.organizer?.self !== true ||
          !startsAt ||
          !endsAt ||
          extractRoomLinkCode(
            this.appUrl,
            item.location ?? null,
            item.description ?? null,
          ) !== code
        ) {
          continue;
        }
        const window = {
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
        };
        if (window.endsAt.getTime() > window.startsAt.getTime()) {
          return window;
        }
      }
      return null;
    } catch (err) {
      if (err instanceof GrantWithdrawnError) {
        this.tokens.evict(makerId);
        await this.grants.forget(grant);
        this.logger.info(
          { userId: makerId },
          'calendar access withdrawn at google',
        );
      } else if (err instanceof CalendarNotConfiguredError) {
        return null;
      } else if (err instanceof CalendarUnavailableError) {
        this.logger.info(
          { userId: makerId, code },
          'room link maker’s calendar unread; the window stands',
        );
      } else {
        throw err;
      }
      return null;
    }
  }

  private async running(
    token: string,
    now: Date,
    signal: AbortSignal,
  ): Promise<GoogleEvent[]> {
    const url = new URL(EVENTS_URL);
    url.search = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: new Date(
        now.getTime() + ROOM_LINK_OPENS_EARLY_MS + 1,
      ).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(PAGE_SIZE),
      fields: ENTRY_EVENT_FIELDS,
    }).toString();
    return (await this.get(url, token, signal)).items ?? [];
  }

  private read(
    grant: CalendarGrant,
    from: Date,
    to: Date,
    signal: AbortSignal,
  ): Promise<EventsRead> {
    return this.withToken(grant, signal, (token) =>
      this.list(token, from, to, signal),
    );
  }

  /** With a fresh access token once, if Google rejects the cached one. */
  private async withToken<T>(
    grant: CalendarGrant,
    signal: AbortSignal,
    use: (token: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const token = await this.tokens.get(grant, signal);
        return await use(token);
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
  ): Promise<EventsRead> {
    const events: CalendarEventDto[] = [];
    const codes: (string | null)[] = [];
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
      for (const item of body.items ?? []) {
        for (const event of toCalendarEvent(item)) {
          events.push(event);
          codes.push(
            extractRoomLinkCode(
              this.appUrl,
              item.location ?? null,
              item.description ?? null,
            ),
          );
        }
      }
      pageToken = body.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return { events, codes, truncated: pageToken !== undefined };
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

  /**
   * Sets `room` on the events whose links the member may open, in one lookup
   * after the read. The events are worth more than the rooms, so a failed
   * lookup leaves every `room` null rather than failing the answer.
   */
  private async placeInRooms(
    user: AuthenticatedUser,
    events: CalendarEventDto[],
    codes: (string | null)[],
  ): Promise<void> {
    const found = codes.filter((c): c is string => c !== null);
    if (found.length === 0) {
      return;
    }
    let rooms: Map<string, RoomLinkTargetDto>;
    try {
      const links = await this.roomLinks.resolve(user, found);
      rooms = new Map(links.map((link) => [link.code, link]));
    } catch (err) {
      this.logger.error(
        { err, userId: user.id },
        'room links lookup failed; events go without rooms',
      );
      return;
    }
    events.forEach((event, i) => {
      const code = codes[i];
      event.room = (code && rooms.get(code)) || null;
    });
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
