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

/** No space with that id. */
export class SpaceNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * The space is retired: off its map, and no new access is given for it.
 * Ending access still works — taking a grant away from a retired space is
 * how the record is kept straight — but nothing new is handed out.
 */
export class SpaceRetiredException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

/**
 * The grant's subject does not exist to be granted to: no account with that
 * id, or no cohort running a track with that id.
 */
export class SpaceMembershipSubjectNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * The subject already holds a grant on this space whose span covers now, so
 * a second would overlap it and leave nobody sure which one ending access
 * would end. End that one first, or wait until it runs out.
 */
export class SpaceMembershipAlreadyLiveException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

/** No grant with that id on this space. */
export class SpaceMembershipNotFoundException extends DomainException {
  readonly code = ExceptionCode.NotFound;
}

/**
 * The grant has already been ended: its span closed at or before now, and
 * the row stays as the record. Ending it twice would move the record.
 */
export class SpaceMembershipAlreadyEndedException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

/**
 * The grant's span has not begun: ending closes it at now, and a close
 * after its open is the one thing the window rule will not take. No route
 * makes such a grant — one starts when it is given — so this is for rows
 * written another way, and for an end asked for before the start.
 */
export class SpaceMembershipNotStartedException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}

/**
 * The request's own terms: more than one subject, none, or an end date that
 * has already passed — which the window rule would refuse anyway.
 */
export class SpaceMembershipInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

/**
 * A space combination the database's own checks refuse: a default space that
 * is not normal, or a capacity below 1. The row is the caller's to correct,
 * so it is a 400 and not a server fault.
 */
export class SpaceInvalidArgumentException extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

/**
 * The campus already has the one of this kind a space is being made: a second
 * town hall or notice board. The row itself is sound; it is the existing one
 * that keeps the kind.
 */
export class SpaceConflictException extends DomainException {
  readonly code = ExceptionCode.Conflict;
}
