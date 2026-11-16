import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import type { RoomLinkTargetDto } from '../room-links/dto/room-link.dto.js';
import { RoomLinksService } from '../room-links/room-links.service.js';
import { AccessTokenCache } from './access-token-cache.js';
import {
  CalendarGrantsService,
  type CalendarGrant,
} from './calendar-grants.service.js';
import type {
  CalendarEventDto,
  CalendarEventsDto,
  CalendarEventsQueryDto,
} from './dto/calendar-events.dto.js';
import {
  GoogleCalendarApi,
  PRIMARY_EVENTS_URL,
} from './google-calendar-api.js';
import { GrantWithdrawnError } from './google-calendar.client.js';
import {
  GOOGLE_EVENT_FIELDS,
  toCalendarEvent,
  type GoogleEvent,
} from './google-event.js';
import { extractRoomLinkCode } from './room-link.js';

const PAGE_SIZE = 250;
export const MAX_PAGES = 4;
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

/** A member's events, read from Google when asked. */
@Injectable()
export class CalendarEventsService {
  private readonly appUrl: string;

  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly tokens: AccessTokenCache,
    private readonly api: GoogleCalendarApi,
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
    const grant = await this.grants.find(user.id);
    const { from, to } = window(query);
    if (!grant) {
      return NOT_CONNECTED;
    }
    try {
      const signal = AbortSignal.timeout(READ_BUDGET_MS);
      const { events, codes, truncated } = await this.list(
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
      await this.withdrawn(grant);
      return NOT_CONNECTED;
    }
  }

  private async withdrawn(grant: CalendarGrant): Promise<void> {
    this.tokens.evict(grant.userId);
    await this.grants.forget(grant);
    this.logger.info(
      { userId: grant.userId },
      'calendar access withdrawn at google',
    );
  }

  private async list(
    grant: CalendarGrant,
    from: Date,
    to: Date,
    signal: AbortSignal,
  ): Promise<{
    events: CalendarEventDto[];
    codes: (string | null)[];
    truncated: boolean;
  }> {
    const events: CalendarEventDto[] = [];
    const codes: (string | null)[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(PRIMARY_EVENTS_URL);
      url.search = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(PAGE_SIZE),
        fields: GOOGLE_EVENT_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const body = await this.api.get<GoogleEventList>(grant, url, signal);
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

  /** A failed lookup leaves every room null rather than failing the read. */
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
