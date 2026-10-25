import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class CalendarNotConfiguredError extends DomainException {
  readonly code = ExceptionCode.NotFound;

  constructor() {
    super('Google Calendar is not available on this deployment');
  }
}

export class CalendarUnavailableError extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;

  constructor() {
    super('Google Calendar is not answering just now. Try again shortly.');
  }
}

export type CalendarConnectFailure =
  | 'invalid_state'
  | 'expired_state'
  | 'denied'
  | 'missing_code'
  | 'exchange_failed'
  | 'wrong_account'
  | 'not_granted'
  | 'no_refresh_token';

const MESSAGES: Record<CalendarConnectFailure, string> = {
  invalid_state: 'The connection request could not be verified. Start again.',
  expired_state: 'The connection request expired. Start again.',
  denied: 'Calendar access was cancelled at Google.',
  missing_code: 'Google did not return an authorization code.',
  exchange_failed: 'Google did not accept the authorization code.',
  wrong_account:
    'Connect the calendar of the Google account you sign in to campus with.',
  not_granted: 'Calendar access was not granted.',
  no_refresh_token:
    'Google did not hand over lasting access. Ask for offline access with a refresh token.',
};

export class CalendarConnectFailedError extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;

  constructor(readonly reason: CalendarConnectFailure) {
    super(MESSAGES[reason], { reason });
  }
}
