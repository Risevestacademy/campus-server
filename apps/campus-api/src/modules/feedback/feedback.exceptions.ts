import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class FeedbackNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * Something the request's own shape could not show was wrong: an id that
 * names nobody, or a person named on something that is not a report.
 */
export class FeedbackInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

/** This account has sent as much as one account may for now. */
export class FeedbackRateLimitedException extends DomainException {
  readonly code = ExceptionCode.RateLimited;
}
