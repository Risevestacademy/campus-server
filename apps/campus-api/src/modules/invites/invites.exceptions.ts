import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

export class InviteConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

/**
 * The invite already carries an answer. One class per standing answer, all
 * 409, so a caller can branch on `error.code` instead of parsing the message:
 * 'accepted' is the one that sends someone back through sign-in, the other
 * two close the flow.
 *
 * Shared by the decision and validation routes on purpose — the same fact
 * about the same invite must not report a different code depending on which
 * endpoint noticed it.
 */
export class InviteAlreadyAcceptedException extends DomainException {
  readonly code = ExceptionCode.InviteAlreadyAccepted;
}

export class InviteAlreadyDeclinedException extends DomainException {
  readonly code = ExceptionCode.InviteAlreadyDeclined;
}

export class InviteRevokedException extends DomainException {
  readonly code = ExceptionCode.InviteRevoked;
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

/**
 * The invite lapsed. Lapsed-but-still-pending and materialised Expired are
 * one outcome, so every route that finds either answers with this.
 */
export class InviteExpiredException extends DomainException {
  readonly code = ExceptionCode.InviteExpired;
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
