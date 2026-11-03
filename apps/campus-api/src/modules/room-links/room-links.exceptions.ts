import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class RoomLinkNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class RoomLinkForbiddenException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}
