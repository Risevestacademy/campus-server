import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class InviteConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

export class InviteInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

export class InviteNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class InviteForbiddenException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}

export class InviteUnauthorizedException extends DomainException {
  readonly code = ExceptionCode.Unauthorized;
}
