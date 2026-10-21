import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class MentorshipGroupConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class MentorshipGroupInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

export class MentorshipGroupNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}
