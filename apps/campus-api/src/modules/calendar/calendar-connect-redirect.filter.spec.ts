import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';
import { NotAuthenticatedException } from '../../shared/exceptions/index.js';
import { ValidationException } from '../../shared/exceptions/validation.exception.js';
import { CalendarConnectRedirectFilter } from './calendar-connect-redirect.filter.js';
import {
  CalendarConnectFailedError,
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';

const config = { APP_PUBLIC_URL: 'https://campus.example/' } as Env;
const logger = { warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };
const filter = new CalendarConnectRedirectFilter(
  config,
  logger as unknown as PinoLogger,
);

function redirectFor(exception: unknown): string {
  const res = { redirect: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', id: 'correlation-1' }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return res.redirect.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  [new CalendarConnectFailedError('wrong_account'), 'wrong_account'],
  [new CalendarConnectFailedError('expired_state'), 'expired_state'],
  [new NotAuthenticatedException('no session'), 'unauthorized'],
  [new HttpException('forbidden', HttpStatus.FORBIDDEN), 'unauthorized'],
  [new CalendarNotConfiguredError(), 'not_available'],
  [new CalendarUnavailableError(), 'unavailable'],
  [new ValidationException([]), 'invalid_request'],
  [
    new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS),
    'rate_limited',
  ],
  [new Error('boom'), 'server_error'],
])('sends %s back to the web app as %s', (exception, outcome) => {
  expect(redirectFor(exception)).toBe(
    `https://campus.example/campus?calendar=${outcome}`,
  );
});

it('logs a failure on our side, and only that', () => {
  redirectFor(new CalendarConnectFailedError('denied'));
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();

  redirectFor(new Error('boom'));
  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ correlationId: 'correlation-1' }),
    'Unhandled exception',
  );
});
