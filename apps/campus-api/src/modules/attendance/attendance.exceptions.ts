import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class AttendanceNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class AttendanceForbiddenException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}
