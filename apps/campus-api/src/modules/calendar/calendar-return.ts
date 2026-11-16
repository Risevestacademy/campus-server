import type { Env } from '../../infra/config/config.module.js';
import { appUrl } from '../../shared/http/app-url.js';
import { CALENDAR_CONNECT_FAILURES } from './calendar.exceptions.js';

/** Every `?calendar=` the web app can be sent back with. */
export const CALENDAR_CONNECT_OUTCOMES = [
  'connected',
  ...CALENDAR_CONNECT_FAILURES,
  'unauthorized',
  'not_available',
  'unavailable',
  'invalid_request',
  'rate_limited',
  'server_error',
] as const;

export type CalendarConnectOutcome = (typeof CALENDAR_CONNECT_OUTCOMES)[number];

export const CALENDAR_RETURN_PATH = '/campus';

export function calendarReturnUrl(
  config: Env,
  outcome: CalendarConnectOutcome,
): string {
  return appUrl(config, `${CALENDAR_RETURN_PATH}?calendar=${outcome}`);
}
