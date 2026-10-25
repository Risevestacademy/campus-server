import type { Env } from '../../infra/config/config.module.js';
import { CalendarNotConfiguredError } from './calendar.exceptions.js';

export const GOOGLE_CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly';

export interface CalendarSettings {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
  tokenKey: Buffer;
}

export function requireCalendar(env: Env): CalendarSettings {
  if (
    !env.FF_GOOGLE_CALENDAR_ENABLED ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_CALENDAR_CALLBACK_URL ||
    !env.AUTH_STATE_SECRET ||
    !env.GOOGLE_CALENDAR_TOKEN_KEY
  ) {
    throw new CalendarNotConfiguredError();
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl: env.GOOGLE_CALENDAR_CALLBACK_URL,
    stateSecret: env.AUTH_STATE_SECRET,
    tokenKey: Buffer.from(env.GOOGLE_CALENDAR_TOKEN_KEY, 'base64'),
  };
}

/** The key alone, for removing a grant while the calendar is switched off. */
export function calendarTokenKey(env: Env): Buffer | null {
  return env.GOOGLE_CALENDAR_TOKEN_KEY
    ? Buffer.from(env.GOOGLE_CALENDAR_TOKEN_KEY, 'base64')
    : null;
}
