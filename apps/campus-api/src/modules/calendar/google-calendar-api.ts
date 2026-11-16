import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AccessTokenCache } from './access-token-cache.js';
import type { CalendarGrant } from './calendar-grants.service.js';
import { CalendarUnavailableError } from './calendar.exceptions.js';
import {
  CALENDAR_FETCH,
  GrantWithdrawnError,
} from './google-calendar.client.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const PRIMARY_EVENTS_URL = `${CALENDAR_API}/calendars/primary/events`;

/** Google no longer accepts the sync token; the calendar is read in full. */
export class SyncTokenExpiredError extends Error {}

class AccessTokenRejected extends Error {}

/** Calendar API requests made with a grant's access token. */
@Injectable()
export class GoogleCalendarApi {
  constructor(
    private readonly tokens: AccessTokenCache,
    @Inject(CALENDAR_FETCH) private readonly fetch: typeof globalThis.fetch,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GoogleCalendarApi.name);
  }

  get<T>(grant: CalendarGrant, url: URL, signal: AbortSignal): Promise<T> {
    return this.request<T>(grant, url, { method: 'GET' }, signal);
  }

  post<T>(
    grant: CalendarGrant,
    url: URL,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    return this.request<T>(
      grant,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  /** With a fresh access token once, if Google rejects the cached one. */
  private async request<T>(
    grant: CalendarGrant,
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const token = await this.tokens.get(grant, signal);
        return await this.send<T>(url, token, init, signal);
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

  private async send<T>(
    url: URL,
    token: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      this.logger.error({ err }, 'google calendar unreachable');
      throw new CalendarUnavailableError();
    }

    if (res.ok) {
      if (res.status === 204) {
        return undefined as T;
      }
      try {
        return (await res.json()) as T;
      } catch (err) {
        this.logger.error({ err }, 'google calendar answered unreadably');
        throw new CalendarUnavailableError();
      }
    }
    if (res.status === 401) {
      throw new AccessTokenRejected();
    }
    if (res.status === 410) {
      throw new SyncTokenExpiredError();
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
      'google calendar refused a request',
    );
    throw new CalendarUnavailableError();
  }
}
