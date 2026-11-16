import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/** None with that id, or one that is somebody else's. */
export class NotificationNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}
