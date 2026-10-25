import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  resolveExceptionStatus,
  ValidationException,
} from '../../shared/exceptions/index.js';
import {
  CalendarConnectFailedError,
  CalendarNotConfiguredError,
  type CalendarConnectFailure,
} from './calendar.exceptions.js';

export type CalendarConnectOutcome =
  | 'connected'
  | CalendarConnectFailure
  | 'unauthorized'
  | 'not_available'
  | 'invalid_request'
  | 'rate_limited'
  | 'server_error';

export const CALENDAR_RETURN_PATH = '/campus';

export function calendarReturnUrl(
  config: Env,
  outcome: CalendarConnectOutcome,
): string {
  return `${config.APP_PUBLIC_URL.replace(/\/+$/, '')}${CALENDAR_RETURN_PATH}?calendar=${outcome}`;
}

/**
 * Connecting is a top-level navigation, so every failure goes back to the web
 * app with a code it can explain, never a JSON body.
 */
@Catch()
export class CalendarConnectRedirectFilter implements ExceptionFilter {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarConnectRedirectFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const outcome = connectOutcome(exception);
    if (outcome === 'server_error') {
      const req = ctx.getRequest<Request & { id?: string }>();
      const fault =
        resolveExceptionStatus(exception) >= HttpStatus.INTERNAL_SERVER_ERROR;
      this.logger[fault ? 'error' : 'warn'](
        { err: exception, method: req.method, correlationId: req.id },
        fault ? 'Unhandled exception' : 'Unexpected calendar connect failure',
      );
    }
    ctx
      .getResponse<Response>()
      .redirect(calendarReturnUrl(this.config, outcome));
  }
}

export function connectOutcome(exception: unknown): CalendarConnectOutcome {
  if (exception instanceof CalendarConnectFailedError) {
    return exception.reason;
  }
  if (exception instanceof CalendarNotConfiguredError) {
    return 'not_available';
  }
  if (exception instanceof ValidationException) {
    return 'invalid_request';
  }
  const status = resolveExceptionStatus(exception);
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return 'unauthorized';
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return 'rate_limited';
  }
  return 'server_error';
}
