import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/** No webhook key pair is set, so no webhook can be told from a forgery. */
export class CallWebhooksNotConfiguredException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

export class CallWebhookUnverifiedException extends DomainException {
  readonly code = ExceptionCode.Unauthorized;
}

/** Recording is not set up here: no LiveKit URL or bucket configured. */
export class RecordingNotConfiguredException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

/** LiveKit would not start the recording, such as when the plan's minutes are used up. */
export class RecordingUnavailableException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

export class RecordingForbiddenException extends DomainException {
  readonly code = ExceptionCode.Forbidden;
}

export class RecordingNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/** No call to record, one already recording, or one not yet under way to stop. */
export class RecordingConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}
