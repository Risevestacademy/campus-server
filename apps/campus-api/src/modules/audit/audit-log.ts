import type { DbExecutor } from '../../infra/database/database.constants.js';
import { auditLog, type AuditAction, type AuditSubjectType } from './schema.js';

/** Who did it and which request — the parts every entry from one call shares. */
export interface AuditContext {
  actorUserId: string | null;
  correlationId?: string;
}

/**
 * The fields an edit moved, each with the value it had and the value it has
 * now. Typed by the snapshot the action records, so an entry can name only
 * the fields its action covers, and each `from` and `to` has that field's
 * own type.
 */
export type FieldChanges<T> = {
  [K in keyof T]?: { from: T[K]; to: T[K] };
};

/**
 * What an entry records about a cohort: the fields an admin can set.
 *
 * This and every payload below is the audit log's own contract, written out
 * here rather than picked off the cohorts, tracks or invites row types. The
 * modules that write entries depend on this one; it does not depend back on
 * them. So a role or a status is a `string` here: the vocabularies belong to
 * the modules that own them, and the log records the value it was given.
 *
 * A caller's row still has to fit. Passing a column whose type has drifted
 * from what is written here fails at the call site.
 */
export interface CohortSnapshot {
  name: string;
  code: string;
  status: string;
  /** A calendar date, `YYYY-MM-DD`. */
  startDate: string | null;
  endDate: string | null;
}

/** The same for a track. */
export interface TrackSnapshot {
  name: string;
  code: string;
  description: string | null;
}

/** A membership as it stood before a revive overwrote it. */
export interface MembershipSnapshot {
  role: string;
  cohortTrackId: string | null;
  status: string | null;
  dismissalReason: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  accessExpiresAt: Date | null;
}

/**
 * What each action is about and what it records — the one place that says
 * so. An entry for an action must carry that action's subject type and
 * exactly its details, so a cohort entry filed under a track, or a detail
 * left out or misspelt, does not compile.
 *
 * Adding an action means adding it here, and to the table in README.md.
 */
interface AuditEntryShapes {
  [AuditAction.MembershipRevived]: {
    subject: AuditSubjectType.CohortMember;
    details: {
      inviteId: string;
      invitedBy: string;
      previous: MembershipSnapshot;
    };
  };
  [AuditAction.SystemRoleChanged]: {
    subject: AuditSubjectType.User;
    details: {
      /** Null for an account created with the role it now has. */
      from: string | null;
      to: string;
    } & (
      | { inviteId: string; invitedBy: string } // an accepted invite granted it
      | { source: 'seed' } // the seed did, on nobody's behalf
      | { source: 'admin' } // an admin did, through the API; they are the actor
    );
  };
  [AuditAction.InviteCreated]: {
    subject: AuditSubjectType.Invite;
    details: {
      cohortId: string | null;
      cohortRole: string | null;
      cohortTrackId: string | null;
      systemRole: string;
      expiresAt: Date;
      guestAccessExpiresAt: Date | null;
    };
  };
  [AuditAction.InviteRevoked]: {
    subject: AuditSubjectType.Invite;
    details: { cohortId: string | null; expiresAt: Date };
  };
  [AuditAction.InviteResent]: {
    subject: AuditSubjectType.Invite;
    details: {
      cohortId: string | null;
      /** The deadline the resend set, and the one it replaced. */
      expiresAt: Date;
      previousExpiresAt: Date;
    };
  };
  [AuditAction.InviteFlagged]: {
    subject: AuditSubjectType.Invite;
    details: { cohortId: string | null; invitedBy: string };
  };
  [AuditAction.CohortCreated]: {
    subject: AuditSubjectType.Cohort;
    details: CohortSnapshot;
  };
  [AuditAction.CohortUpdated]: {
    subject: AuditSubjectType.Cohort;
    details: { changes: FieldChanges<CohortSnapshot> };
  };
  [AuditAction.CohortDeleted]: {
    subject: AuditSubjectType.Cohort;
    details: CohortSnapshot;
  };
  [AuditAction.CohortTrackAttached]: {
    subject: AuditSubjectType.CohortTrack;
    details: { cohortId: string; trackId: string };
  };
  [AuditAction.TrackCreated]: {
    subject: AuditSubjectType.Track;
    details: Pick<TrackSnapshot, 'name' | 'code'>;
  };
  [AuditAction.TrackUpdated]: {
    subject: AuditSubjectType.Track;
    details: { changes: FieldChanges<TrackSnapshot> };
  };
  [AuditAction.TrackDeleted]: {
    subject: AuditSubjectType.Track;
    details: TrackSnapshot;
  };
}

/**
 * One entry, as a union discriminated by `action`: naming the action fixes
 * the subject type and the details that go with it.
 *
 * Built from AuditEntryShapes rather than written out member by member, and
 * mapped over the whole enum — so an action added to AuditAction without a
 * shape fails here, not at the first call site that happens to use it.
 */
export type AuditEntry = {
  [A in AuditAction]: AuditContext & {
    action: A;
    subject: { type: AuditEntryShapes[A]['subject']; id: string };
    details: AuditEntryShapes[A]['details'];
  };
}[AuditAction];

/**
 * The listed fields whose value differs between the row before an edit and
 * after it, each with both values — what an update entry records, rather than
 * the request body, which may name fields it left as they were.
 */
export function changedFields<T extends object, K extends keyof T>(
  before: T,
  after: T,
  fields: readonly K[],
): FieldChanges<Pick<T, K>> {
  const changes: FieldChanges<Pick<T, K>> = {};
  for (const field of fields) {
    if (!Object.is(before[field], after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

/**
 * Appends one entry. Takes the caller's transaction rather than the pool on
 * purpose: the entry commits or rolls back with the change it describes, so
 * the log can never claim something that did not happen, nor miss something
 * that did.
 */
export async function writeAuditEntry(
  executor: DbExecutor,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    subjectType: entry.subject.type,
    subjectId: entry.subject.id,
    details: entry.details,
    // Stored as given, never trimmed: the request's id is settled as it
    // arrives (resolveCorrelationId) and already fits the column, so the
    // entry carries the same id as the log lines and the response header.
    correlationId: entry.correlationId ?? null,
  });
}
