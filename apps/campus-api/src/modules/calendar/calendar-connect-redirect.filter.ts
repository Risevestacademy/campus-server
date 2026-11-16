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
import { logRedirectedFailure } from '../../shared/filters/redirected-failure.js';
import {
  calendarReturnUrl,
  type CalendarConnectOutcome,
} from './calendar-return.js';
import {
  CalendarConnectFailedError,
  CalendarNotConfiguredError,
  CalendarUnavailableError,
} from './calendar.exceptions.js';

/**
 * Connecting is a top-level navigation, so every failure goes back to the web
 * app with a code it can explain, never a JSON body. Sign-in answers a
 * switched-off deployment with a 404; here that would strand the member on a
 * JSON page inside campus, so it is `not_available` instead.
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
      logRedirectedFailure(
        this.logger,
        exception,
        ctx.getRequest<Request & { id?: string }>(),
        'Unexpected calendar connect failure',
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
  if (exception instanceof CalendarUnavailableError) {
    return 'unavailable';
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
