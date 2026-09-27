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

/**
 * An invariant this service relies on does not hold — e.g. a provisional
 * session whose invite is addressed to a different account. Both inputs are
 * server-derived (the verified identity and a signed cookie), so no caller
 * can reach this state; it can only mean a bug upstream.
 *
 * Deliberately 500 rather than 404: GlobalExceptionFilter logs every status
 * >= 500 and returns only its generic message, so the diagnosis lands in the
 * log with both addresses in it while neither reaches the client. Answering
 * 404 would dress a server fault up as a user error and bury it.
 */
export class InviteInternalException extends DomainException {
  readonly code = ExceptionCode.InternalError;
}
