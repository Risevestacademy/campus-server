import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/**
 * No such notice, or one the caller may not see. Both are this one exception
 * with the same message and details, so a refusal cannot reveal which.
 */
export class NoticeNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}
