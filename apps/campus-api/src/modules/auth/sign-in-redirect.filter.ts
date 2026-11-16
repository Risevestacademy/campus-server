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
import { DomainExceptionFilter } from '../../shared/filters/index.js';
import { logRedirectedFailure } from '../../shared/filters/redirected-failure.js';
import { appUrl } from '../../shared/http/app-url.js';
import {
  AccountSuspendedError,
  GoogleAuthNotConfiguredError,
  GoogleSignInFailedError,
  InviteRequiredError,
  type GoogleSignInFailure,
} from './auth.exceptions.js';
import { STATE_COOKIE, STATE_COOKIE_PATH } from './state-cookie.js';

/**
 * What the web app's sign-in page is told in `?error=`. A closed set, so the
 * page can map each one to its own copy.
 */
export type SignInErrorCode =
  | GoogleSignInFailure
  | 'invite_required'
  | 'account_suspended'
  | 'invalid_request'
  | 'rate_limited'
  | 'server_error';

export const SIGN_IN_PATH = '/sign-in';

/**
 * The callback is a top-level navigation, so a JSON error body would leave
 * the user staring at raw JSON on the API's own domain. Every failure goes
 * back to the web app's sign-in page instead, carrying a code it can explain.
 *
 * The one exception is a deployment with Google sign-in switched off: that
 * answers 404 like any route that is not there, the same as the start route.
 */
@Catch()
export class SignInRedirectFilter implements ExceptionFilter {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SignInRedirectFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof GoogleAuthNotConfiguredError) {
      new DomainExceptionFilter().catch(exception, host);
      return;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const code = signInErrorCode(exception);

    // Every server_error is logged: the user is told something went wrong on
    // our side, so there has to be a record of what.
    if (code === 'server_error') {
      logRedirectedFailure(
        this.logger,
        exception,
        ctx.getRequest<Request & { id?: string }>(),
        'Unexpected sign-in failure',
      );
    }

    // Already cleared on the handler's own path, but a query that fails
    // validation never reaches the handler, and the state is single-use.
    res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
    res.redirect(appUrl(this.config, `${SIGN_IN_PATH}?error=${code}`));
  }
}

export function signInErrorCode(exception: unknown): SignInErrorCode {
  if (exception instanceof GoogleSignInFailedError) {
    return exception.reason;
  }
  if (exception instanceof InviteRequiredError) {
    return 'invite_required';
  }
  if (exception instanceof AccountSuspendedError) {
    return 'account_suspended';
  }
  if (exception instanceof ValidationException) {
    return 'invalid_request';
  }
  if (resolveExceptionStatus(exception) === HttpStatus.TOO_MANY_REQUESTS) {
    return 'rate_limited';
  }
  return 'server_error';
}
