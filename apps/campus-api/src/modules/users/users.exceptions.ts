import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/**
 * The address is spoken for by a different Google account. A DomainException
 * rather than a bare Error so the caller is told what happened instead of
 * meeting a 500 — this is a state of the world, not a fault.
 */
export class GoogleIdentityMismatchError extends DomainException {
  readonly code = ExceptionCode.Conflict;

  constructor(email: string) {
    super(`${email} is already linked to a different Google account`, {
      email,
    });
  }
}
