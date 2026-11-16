import { DomainException } from './domain.exception.js';
import { ExceptionCode } from './exception-code.enum.js';

/**
 * No usable caller identity — nothing on the request says who this is.
 * Distinct from AccessDeniedException, which knows who the caller is and
 * refuses them anyway.
 */
export class NotAuthenticatedException extends DomainException {
  readonly code = ExceptionCode.Unauthorized;
}

/** Authenticated, but not permitted to do this. */
export class AccessDeniedException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}

/** The request itself is malformed, in a way the route DTOs did not catch. */
export class InvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}
