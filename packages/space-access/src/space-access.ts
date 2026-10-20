import { hasAdminPowers } from '@campus/session';

/**
 * Whether a person may step into a space: facts in, a boolean out. One pure
 * function — no database, no sockets, no clock of its own (the caller passes
 * `at`, so a test can stand at any moment).
 *
 * campus-api and world both have to ask it: world on every step into a space,
 * campus-api whenever a route needs the same answer. So it lives where both
 * can import it, defined once — the way `@campus/session` holds the session
 * token and the system role. Two copies of this rule would drift, and the
 * drift would not show as a type error: it would show as somebody standing
 * where they should not be, on one service and not the other.
 *
 * Everything it needs arrives as plain data. Which rows those facts come from,
 * and when they are read, belongs to the caller: this decides what the facts
 * mean, not how they are found.
 */

/**
 * `space_access`, the two kinds of space. A `normal` space admits anybody in
 * the campus unless the people inside have locked it; a `designated` one
 * admits whoever its list names. The same values campus-api writes into the
 * column; a value this does not know — one added to the database before this
 * package knew of it — admits admins only, the way `hasAdminPowers` treats a
 * system role it does not know: the safe way to be wrong.
 */
export const SPACE_ACCESS = {
  Normal: 'normal',
  Designated: 'designated',
} as const;

export type SpaceAccess = (typeof SPACE_ACCESS)[keyof typeof SPACE_ACCESS];

/**
 * The `cohort_members.role` value whose liveness reads differently: a student
 * counts only while explicitly `active`. Every other role, guest included, is
 * matched by a list entry naming it as text, so nothing here needs to know
 * the rest.
 */
export const COHORT_ROLES = {
  Student: 'student',
  Guest: 'guest',
} as const;

/**
 * The one `student_status` that counts a student in good standing, mirrored
 * from campus-api's `StudentStatus`. A student row with any other status — or
 * with none, which is a half-finished enrolment — is not a live membership.
 */
export const ACTIVE_STUDENT_STATUS = 'active';

/** What a membership in `cohort_members` says, for the cohort being walked. */
export interface CohortMembershipFacts {
  /** The cohort this membership is in. Must match `PersonFacts.cohortId`. */
  cohortId: string;
  /** `cohort_members.role` as text. */
  role: string;
  /** When the membership ended, or null while it stands. */
  leftAt: Date | null;
  /** `student_status`, for students; null for everybody else. */
  status: string | null;
  /** When a guest's visit ends, or null for a role that does not expire. */
  accessExpiresAt: Date | null;
  /** The membership's `cohort_track_id`: what a track grant matches. */
  trackId: string | null;
}

/**
 * One row of `space_memberships`: one entry on a designated space's list, and
 * for how long it counts. Exactly one subject is set, which the database
 * insists on (`space_memberships_one_subject`); a row naming none, if one ever
 * slipped in, admits nobody.
 */
export interface SpaceGrantFacts {
  /** A person, whichever cohort they walk. */
  toUserId: string | null;
  /** Everybody on this cohort track: only ever one cohort's people. */
  toTrackId: string | null;
  /** Everybody holding this `cohort_members.role` in the cohort walked. */
  toCohortRole: string | null;
  /** Everybody holding this `users.system_role`. */
  toSystemRole: string | null;
  /** When the grant starts counting. */
  validFrom: Date;
  /** When it stops, or null while it has no end. */
  validTo: Date | null;
}

/** Who is asking, and which cohort's campus they are asking about. */
export interface PersonFacts {
  userId: string;
  /** `users.system_role` as text; world reads it off the row, never a token. */
  systemRole: string;
  /**
   * The cohort this check is made for: world's socket `cohortId`, or the
   * cohort an API route acts under. Spaces belong to no cohort — every cohort
   * walks the same map — so the campus context has to come from the caller,
   * and the answer is only ever about this cohort.
   */
  cohortId: string;
  /**
   * Their `cohort_members` row *in that cohort*, or null if they hold none.
   * The caller reads it; this decides whether it is live.
   */
  membership: CohortMembershipFacts | null;
}

/** The parts of a space row that decide entry. */
export interface SpaceFacts {
  /** `spaces.kind` as text: null means the space is not set up yet. */
  kind: string | null;
  /** `spaces.access` as text. */
  access: string;
  /** When the space was taken off the map, or null while it stands. */
  retiredAt: Date | null;
  /**
   * Whether the people inside have locked it, in this cohort's copy of the
   * campus. Only a normal space can be; world holds the lock, not the
   * database.
   */
  locked: boolean;
  /**
   * This space's list: its `space_memberships` rows. The caller supplies
   * them; an entry on another space is no business of this one's.
   */
  grants: readonly SpaceGrantFacts[];
}

/**
 * A membership counts while it stands: not ended, a student explicitly
 * active, and any visit not yet run out.
 *
 * This is the written form of the question campus-api's `isLiveMembership`
 * and world's `LIVE_MEMBERSHIP_QUERY` both ask in SQL — those two must stay
 * the same question, and this is where the words are, so neither of them is
 * the only place the rule exists. It uses `is not distinct from` thinking on
 * status: a student with no status is a half-finished enrolment, not a
 * standing invitation, so only exactly `active` qualifies.
 */
export function isLiveMembership(
  membership: CohortMembershipFacts,
  at: Date,
): boolean {
  return (
    membership.leftAt === null &&
    (membership.role !== COHORT_ROLES.Student ||
      membership.status === ACTIVE_STUDENT_STATUS) &&
    (membership.accessExpiresAt === null ||
      membership.accessExpiresAt.getTime() > at.getTime())
  );
}

/**
 * A grant counts only between its start and its end — the start included, the
 * end the moment it stops. `validFrom <= at`, never `<`: a grant that begins
 * at this instant is already there.
 *
 * Dates, not strings: a caller reading rows gets `Date` back from both the
 * Postgres drivers in this repo, and comparing anything else here would fail
 * rather than guess.
 */
export function isLiveGrant(grant: SpaceGrantFacts, at: Date): boolean {
  return (
    grant.validFrom.getTime() <= at.getTime() &&
    (grant.validTo === null || grant.validTo.getTime() > at.getTime())
  );
}

/**
 * May they enter? Decided in this order, first match standing:
 *
 * 1. **A retired space admits nobody** — admins included. Retired is off the
 *    map entirely; an admin manages such a space through admin routes, not by
 *    walking in.
 * 2. **No kind is not set up yet**, and admits admins only, whatever `access`
 *    says — a half-set-up space is not open for business by accident.
 * 3. **Admins enter anything** that is set up and standing, past a lock and
 *    whatever a list says.
 * 4. **Everybody else must be in this campus**: a live membership in the
 *    cohort the question names. Ended, expired, absent, or held in some other
 *    cohort — all no. The roster is the campus. A membership named for the
 *    wrong cohort is a check made wrong, so it reads as none: fail closed.
 * 5. **A normal space** admits them unless it is locked. A guest is no
 *    different here; that they may not lock one is for whoever holds locks.
 * 6. **A designated space** admits them if a live entry on its list names
 *    them: by person, by their track in this cohort, by their role in this
 *    cohort, or by their system role. A guest gets in the same way, by an
 *    entry that names them or their role.
 * 7. **Anything else** — an access value this package does not know — says
 *    no.
 *
 * The list is only ever read for a designated space: nobody is kept out of an
 * unlocked normal space, so an entry there has nothing to do, and it cannot
 * open a lock.
 */
export function mayEnter(
  person: PersonFacts,
  space: SpaceFacts,
  at: Date,
): boolean {
  if (space.retiredAt !== null) {
    return false;
  }
  if (space.kind === null) {
    return hasAdminPowers(person.systemRole);
  }
  if (hasAdminPowers(person.systemRole)) {
    return true;
  }

  const membership = liveMembershipHere(person, at);
  if (membership === null) {
    return false;
  }

  switch (space.access) {
    case SPACE_ACCESS.Normal:
      return !space.locked;
    case SPACE_ACCESS.Designated:
      return onTheList(space, person, membership, at);
    default:
      return false;
  }
}

/** Whether a live entry on this space's list names them at `at`. */
function onTheList(
  space: SpaceFacts,
  person: PersonFacts,
  membership: CohortMembershipFacts,
  at: Date,
): boolean {
  return space.grants.some(
    (grant) => subjectIs(grant, person, membership) && isLiveGrant(grant, at),
  );
}

/**
 * Their membership in the cohort being walked, if it is live. A row naming
 * another cohort is not an answer to this question — the caller asked about
 * one cohort and handed a membership in a different one — so it is read as
 * holding none rather than taken for the nearest thing.
 */
function liveMembershipHere(
  person: PersonFacts,
  at: Date,
): CohortMembershipFacts | null {
  const { membership } = person;
  if (membership === null || membership.cohortId !== person.cohortId) {
    return null;
  }
  return isLiveMembership(membership, at) ? membership : null;
}

/**
 * Whether an entry names this person: them by id; everybody on the track
 * their membership in this cohort sits on; everybody holding their role in
 * this cohort; or everybody holding their system role. A track entry never
 * matches a membership with no track, nor one on another track. An entry
 * naming none of these, if one slipped past the database, matches nobody.
 */
function subjectIs(
  grant: SpaceGrantFacts,
  person: PersonFacts,
  membership: CohortMembershipFacts,
): boolean {
  if (grant.toUserId !== null) {
    return grant.toUserId === person.userId;
  }
  if (grant.toTrackId !== null) {
    return grant.toTrackId === membership.trackId;
  }
  if (grant.toCohortRole !== null) {
    return grant.toCohortRole === membership.role;
  }
  if (grant.toSystemRole !== null) {
    return grant.toSystemRole === person.systemRole;
  }
  return false;
}
