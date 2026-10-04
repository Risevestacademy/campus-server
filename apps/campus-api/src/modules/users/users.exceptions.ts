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

export class UserNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * The role change is not one anybody may make: the target is a super admin,
 * or the caller is trying to change their own role. A 409 rather than a 403,
 * which on these routes means "you are not an admin" — the caller is one,
 * and it is the state of the target that refuses them.
 */
export class SystemRoleLockedException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}
