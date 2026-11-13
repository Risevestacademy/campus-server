import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/** No R2 buckets configured here. */
export class MediaNotConfiguredException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

export class UploadTooLargeException extends DomainException {
  readonly code = ExceptionCode.UploadTooLarge;
}

export class UploadTypeNotAllowedException extends DomainException {
  readonly code = ExceptionCode.UploadTypeNotAllowed;
}

export class TooManyPendingUploadsException extends DomainException {
  readonly code = ExceptionCode.RateLimited;
}

/** No upload of the caller's, of that kind, is waiting under that id. */
export class UploadNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

export class UploadMismatchException extends DomainException {
  readonly code = ExceptionCode.UploadMismatch;
}
