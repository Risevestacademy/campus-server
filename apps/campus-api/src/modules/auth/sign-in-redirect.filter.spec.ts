import { ThrottlerException } from '@nestjs/throttler';

import { ValidationException } from '../../shared/exceptions/index.js';
import {
  AccountSuspendedError,
  GoogleSignInFailedError,
  InviteRequiredError,
  SessionUnauthorizedError,
} from './auth.exceptions.js';
import { signInErrorCode } from './sign-in-redirect.filter.js';

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
