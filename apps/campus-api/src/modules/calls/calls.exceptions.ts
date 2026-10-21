import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/** No webhook key pair is set, so no webhook can be told from a forgery. */
export class CallWebhooksNotConfiguredException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

export class CallWebhookUnverifiedException extends DomainException {
  readonly code = ExceptionCode.Unauthorized;
}
