import type { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/config.module.js';

import { ValidationException } from '../../shared/exceptions/index.js';
import {
  AccountSuspendedError,
  GoogleSignInFailedError,
  InviteRequiredError,
  SessionUnauthorizedError,
} from './auth.exceptions.js';
import {
  signInErrorCode,
  SignInRedirectFilter,
} from './sign-in-redirect.filter.js';

describe('signInErrorCode', () => {
  it('passes a Google failure reason through as the code', () => {
    expect(signInErrorCode(new GoogleSignInFailedError('expired_state'))).toBe(
      'expired_state',
    );
  });

  it('names the two refusals the sign-in gate makes', () => {
    expect(signInErrorCode(new InviteRequiredError())).toBe('invite_required');
    expect(signInErrorCode(new AccountSuspendedError())).toBe(
      'account_suspended',
    );
  });

  it('tells a malformed callback apart from a throttled one', () => {
    expect(signInErrorCode(new ValidationException([]))).toBe(
      'invalid_request',
    );
    expect(signInErrorCode(new ThrottlerException())).toBe('rate_limited');
  });

  it('says nothing more specific about anything it does not recognise', () => {
    expect(signInErrorCode(new Error('db down'))).toBe('server_error');
    expect(signInErrorCode(new SessionUnauthorizedError('gone'))).toBe(
      'server_error',
    );
  });
});

describe('SignInRedirectFilter logging', () => {
  function run(exception: unknown) {
    const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const res = { clearCookie: vi.fn(), redirect: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'GET', id: 'corr-1' }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new SignInRedirectFilter(
      { APP_PUBLIC_URL: 'http://localhost:3000' } as Env,
      logger as unknown as PinoLogger,
    );

    filter.catch(exception, host);
    return { logger, res };
  }

  it('logs a fault as an error', () => {
    const { logger, res } = run(new Error('db down'));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/sign-in?error=server_error',
    );
  });

  // Told "server_error", so there has to be a record — even for a 4xx.
  it('logs an unexpected 4xx reported as server_error as a warning', () => {
    const { logger } = run(new SessionUnauthorizedError('gone'));

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs nothing for an outcome it can name', () => {
    const { logger } = run(new InviteRequiredError());

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
