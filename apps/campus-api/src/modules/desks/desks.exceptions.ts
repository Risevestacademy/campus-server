import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class DeskNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class DeskConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class DeskForbiddenException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}
