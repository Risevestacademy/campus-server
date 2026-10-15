import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';

/**
 * The published maps could not be read at all: this deployment is not told
 * where they are, or Sanity did not answer. Nothing is wrong with the maps
 * or the request, and trying again later may work.
 */
export class PublishedMapsUnavailableException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

/**
 * The published maps were read, and cannot be taken as they are: nothing is
 * published, a map is broken, or they do not fit together. A 409, because
 * the caller is an admin and it is the state of what is published that
 * refuses them. `details.problems` says what, one line each, for whoever
 * publishes maps to put right.
 */
export class PublishedMapsRejectedException extends DomainException {
  readonly code = ExceptionCode.Conflict;

  constructor(message: string, problems: string[]) {
    super(message, { problems });
  }
}

/**
 * Another sync is running. It is not waited for: a sync reads every
 * published map with the lock held, and a second one queued behind it would
 * hold a database connection for nothing. Trying again once it is done
 * reads what is published then.
 */
export class MapSyncBusyException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}
