import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class CohortConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class CohortInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

export class CohortNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class CohortMemberNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * The membership was ended and committed, but ending the member's sessions
 * failed afterwards. A 5xx with its own code so the caller can tell this
 * half-done state — access is gone, the sessions it should have taken with
 * it are not — from a change that never happened. The ids travel in the
 * details, which the 5xx rule keeps out of the response and in the log.
 */
export class MembershipSessionsNotRevokedException extends DomainException {
  readonly code = ExceptionCode.SessionRevocationFailed;

  constructor(cohortId: string, userId: string, membershipId: string) {
    super('The membership was ended but its sessions were not revoked', {
      cohortId,
      userId,
      membershipId,
    });
  }
}
