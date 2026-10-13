export enum ExceptionCode {
  InvalidArgument = 'INVALID_ARGUMENT',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  /**
   * Which kind of conflict, for callers that have to act on it. All three are
   * 409, so the status alone cannot tell a caller whether to send someone back
   * through sign-in, close the flow, or ask an admin — only the code can.
   */
  InviteAlreadyAccepted = 'INVITE_ALREADY_ACCEPTED',
  InviteAlreadyDeclined = 'INVITE_ALREADY_DECLINED',
  InviteRevoked = 'INVITE_REVOKED',
  /**
   * The invite ran out of time. 403 like FORBIDDEN, but its own code so the
   * admin routes, where FORBIDDEN means "admin role required", can tell the
   * two apart without reading the message.
   */
  InviteExpired = 'INVITE_EXPIRED',
  SpaceAtCapacity = 'SPACE_AT_CAPACITY',
  InviteRequired = 'INVITE_REQUIRED',
  AccountSuspended = 'ACCOUNT_SUSPENDED',
  RateLimited = 'RATE_LIMITED',
  /**
   * A change committed but the sessions it should have ended did not. 500
   * like INTERNAL_ERROR, but its own code so a caller can tell a total
   * failure from this half-done one — the membership ended, the sessions
   * were left alive — and act on it without reading the message.
   */
  SessionRevocationFailed = 'SESSION_REVOCATION_FAILED',
  InternalError = 'INTERNAL_ERROR',
}

export function mapExceptionCodeToStatus(code: ExceptionCode): number {
  switch (code) {
    case ExceptionCode.InvalidArgument:
      return 400;
    case ExceptionCode.Unauthorized:
      return 401;
    case ExceptionCode.Forbidden:
    case ExceptionCode.InviteExpired:
    case ExceptionCode.InviteRequired:
    case ExceptionCode.AccountSuspended:
      return 403;
    case ExceptionCode.NotFound:
      return 404;
    case ExceptionCode.Conflict:
    case ExceptionCode.InviteAlreadyAccepted:
    case ExceptionCode.InviteAlreadyDeclined:
    case ExceptionCode.InviteRevoked:
    case ExceptionCode.SpaceAtCapacity:
      return 409;
    case ExceptionCode.RateLimited:
      return 429;
    case ExceptionCode.SessionRevocationFailed:
    case ExceptionCode.InternalError:
    default:
      return 500;
  }
}
