import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { UsersService } from '../users/users.service.js';
import {
  CalendarGrantsService,
  type CalendarGrant,
} from './calendar-grants.service.js';
import { CalendarStateService } from './calendar-state.service.js';
import {
  CalendarConnectFailedError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';
import { GOOGLE_CALENDAR_SCOPE } from './calendar.settings.js';
import type { CalendarCallbackQueryDto } from './dto/calendar-connect.dto.js';
import {
  EVENT_RESPONSES,
  type CalendarEventDto,
  type CalendarEventsDto,
  type CalendarEventsQueryDto,
  type EventResponse,
} from './dto/calendar-events.dto.js';
import {
  GoogleCalendarClient,
  GrantWithdrawnError,
  type RedeemedCalendarCode,
} from './google-calendar.client.js';

export const CALENDAR_FETCH = Symbol('CALENDAR_FETCH');

const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const FIELDS =
  'nextPageToken,items(id,status,summary,location,htmlLink,hangoutLink,start,end,attendees(self,responseStatus))';
const PAGE_SIZE = 250;
const MAX_PAGES = 4;

const DAY_MS = 86_400_000;
export const DEFAULT_SPAN_DAYS = 7;
export const MAX_SPAN_DAYS = 62;
const EXPIRY_MARGIN_MS = 60_000;
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const NOT_CONNECTED: CalendarEventsDto = { connected: false, events: [] };

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
}

interface GoogleEvent {
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

interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

class AccessTokenRejected extends Error {}

@Injectable()
export class GoogleCalendarService {
  private readonly accessTokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private lastSweep = 0;

  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly google: GoogleCalendarClient,
    private readonly states: CalendarStateService,
    private readonly users: UsersService,
    @Inject(CALENDAR_FETCH) private readonly fetch: typeof globalThis.fetch,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GoogleCalendarService.name);
  }

  connectUrl(user: AuthenticatedUser): string {
    return this.google.authorizationUrl(this.states.issue(user.id), user.email);
  }

  async completeConnect(
    userId: string,
    query: CalendarCallbackQueryDto,
  ): Promise<void> {
    this.states.verify(query.state, userId);
    if (query.error) {
      throw new CalendarConnectFailedError('denied');
    }
    if (!query.code) {
      throw new CalendarConnectFailedError('missing_code');
    }
    await this.keep(userId, await this.google.redeem(query.code, 'web'));
  }

  async connectWithAppCode(
    userId: string,
    serverAuthCode: string,
  ): Promise<void> {
    await this.keep(userId, await this.google.redeem(serverAuthCode, 'app'));
  }

  async events(
    userId: string,
    query: CalendarEventsQueryDto,
  ): Promise<CalendarEventsDto> {
    const grant = await this.grants.find(userId);
    const { from, to } = window(query);
    this.sweepIfDue();
    if (!grant) {
      return NOT_CONNECTED;
    }
    try {
      return { connected: true, events: await this.read(grant, from, to) };
    } catch (err) {
      if (!(err instanceof GrantWithdrawnError)) {
        throw err;
      }
      this.accessTokens.delete(userId);
      await this.grants.forget(grant);
      this.logger.info({ userId }, 'calendar access withdrawn at google');
      return NOT_CONNECTED;
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.accessTokens.delete(userId);
    const refreshToken = await this.grants.remove(userId);
    await this.google.revoke(refreshToken ?? undefined);
  }

  /** Grants of people whose access has ended: deleted, then revoked. */
  async sweep(now: Date = new Date()): Promise<void> {
    this.lastSweep = now.getTime();
    const tokens = await this.grants.removeLapsed(now);
    this.accessTokens.clear();
    for (const token of tokens) {
      await this.google.revoke(token);
    }
  }

  /**
   * At most every ten minutes, on the back of calendar requests rather than a
   * timer: a timer would keep the API awake, and it sleeps when idle.
   */
  private sweepIfDue(now: number = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    this.sweep(new Date(now)).catch((err: unknown) =>
      this.logger.error({ err }, 'calendar retention sweep failed'),
    );
  }

  private async keep(
    userId: string,
    redeemed: RedeemedCalendarCode,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.providerId || user.providerId !== redeemed.subject) {
      // Another Google account's calendar: nothing of it is kept, and its
      // owner is not left with campus on their account.
      await this.google.revoke(redeemed.refreshToken ?? redeemed.accessToken);
      throw new CalendarConnectFailedError('wrong_account');
    }
    if (!redeemed.scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
      throw new CalendarConnectFailedError('not_granted');
    }
    // Not revoked: that would end the member's whole grant, and with it a
    // connection they may already have.
    if (!redeemed.refreshToken) {
      throw new CalendarConnectFailedError('no_refresh_token');
    }
    await this.grants.save(userId, redeemed.refreshToken);
    this.accessTokens.delete(userId);
    this.logger.info({ userId }, 'calendar connected');
    this.sweepIfDue();
  }

  private async read(
    grant: CalendarGrant,
    from: Date,
    to: Date,
  ): Promise<CalendarEventDto[]> {
    try {
      return await this.list(await this.accessToken(grant), from, to);
    } catch (err) {
      if (!(err instanceof AccessTokenRejected)) {
        throw err;
      }
    }
    this.accessTokens.delete(grant.userId);
    try {
      return await this.list(await this.accessToken(grant), from, to);
    } catch (err) {
      if (err instanceof AccessTokenRejected) {
        this.logger.error(
          { userId: grant.userId },
          'google rejected a fresh access token',
        );
        throw new CalendarUnavailableError();
      }
      throw err;
    }
  }

  private async accessToken(grant: CalendarGrant): Promise<string> {
    const now = Date.now();
    const cached = this.accessTokens.get(grant.userId);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) {
      return cached.token;
    }
    const fresh = await this.google.accessToken(grant.refreshToken);
    for (const [userId, entry] of this.accessTokens) {
      if (entry.expiresAt <= now) {
        this.accessTokens.delete(userId);
      }
    }
    this.accessTokens.set(grant.userId, fresh);
    return fresh.token;
  }

  private async list(
    token: string,
    from: Date,
    to: Date,
  ): Promise<CalendarEventDto[]> {
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
        fields: FIELDS,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const body = await this.get(url, token);
      events.push(...(body.items ?? []).flatMap(toEvent));
      pageToken = body.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return events;
  }

  private async get(url: URL, token: string): Promise<GoogleEventList> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
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

function toEvent(item: GoogleEvent): CalendarEventDto[] {
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
