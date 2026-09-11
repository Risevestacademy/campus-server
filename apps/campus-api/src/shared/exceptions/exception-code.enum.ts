export enum ExceptionCode {
  InvalidArgument = 'INVALID_ARGUMENT',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  SpaceAtCapacity = 'SPACE_AT_CAPACITY',
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
      return 403;
    case ExceptionCode.NotFound:
      return 404;
    case ExceptionCode.Conflict:
    case ExceptionCode.SpaceAtCapacity:
      return 409;
    case ExceptionCode.RateLimited:
      return 429;
    case ExceptionCode.InternalError:
    default:
      return 500;
  }
}