import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class TrackConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class TrackNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}
