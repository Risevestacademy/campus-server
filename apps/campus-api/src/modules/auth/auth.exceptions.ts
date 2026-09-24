import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export type GoogleSignInFailure =
  | 'invalid_state'
  | 'expired_state'
  | 'denied'
  | 'missing_code'
  | 'exchange_failed'
  | 'unverified_email'
  | 'incomplete_profile';

const MESSAGES: Record<GoogleSignInFailure, string> = {
  invalid_state: 'Sign-in request could not be verified. Start again.',
  expired_state: 'Sign-in request expired. Start again.',
  denied: 'Sign-in was cancelled at Google.',
  missing_code: 'Google did not return an authorization code.',
  exchange_failed: 'Google sign-in could not be verified.',
  unverified_email: 'This Google account has no verified email address.',
  incomplete_profile: 'Google did not return an email address for this account.',
};

export class GoogleSignInFailedError extends DomainException {
  readonly code = ExceptionCode.Unauthorized;

  constructor(readonly reason: GoogleSignInFailure) {
    super(MESSAGES[reason], { reason });
  }
}

export class InviteRequiredError extends DomainException {
  readonly code = ExceptionCode.InviteRequired;

  constructor() {
    super('No invite found for this email');
  }
}

export class AccountSuspendedError extends DomainException {
  readonly code = ExceptionCode.AccountSuspended;

  constructor() {
    super('This account is suspended.');
  }
}
