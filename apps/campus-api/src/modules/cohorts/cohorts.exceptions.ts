import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class CohortConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class CohortNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class CohortInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}
