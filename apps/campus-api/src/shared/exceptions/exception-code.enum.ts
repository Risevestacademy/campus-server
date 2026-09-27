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
  SpaceAtCapacity = 'SPACE_AT_CAPACITY',
  InviteRequired = 'INVITE_REQUIRED',
  AccountSuspended = 'ACCOUNT_SUSPENDED',
  RateLimited = 'RATE_LIMITED',
  InternalError = 'INTERNAL_ERROR',
}

export function mapExceptionCodeToStatus(code: ExceptionCode): number {
  switch (code) {
    case ExceptionCode.InvalidArgument:
      return 400;
    case ExceptionCode.Unauthorized:
      return 401;
    case ExceptionCode.Forbidden:
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
    case ExceptionCode.InternalError:
    default:
      return 500;
  }
}