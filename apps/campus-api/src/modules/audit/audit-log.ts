import type { DbExecutor } from '../../infra/database/database.constants.js';
import type { Cohort, CohortMember } from '../cohorts/schema.js';
import type { Invite } from '../invites/schema.js';
import type { Track } from '../tracks/schema.js';
import type { SystemRole } from '../users/schema.js';
import {
  CORRELATION_ID_MAX_LENGTH,
  auditLog,
  type AuditAction,
  type AuditSubjectType,
} from './schema.js';

/** Who did it and which request — the parts every entry from one call shares. */
export interface AuditContext {
  actorUserId: string | null;
  correlationId?: string;
}

/**
 * The fields an edit moved, each with the value it had and the value it has
 * now. Keyed by the fields the caller audits, so an entry cannot name one
 * its action does not cover.
 */
export type FieldChanges<K extends string = string> = Partial<
  Record<K, { from: unknown; to: unknown }>
>;

/**
 * What each action is about and what it records — the one place that says
 * so. An entry for an action must carry that action's subject type and
 * exactly its details, so a cohort entry filed under a track, or a detail
 * left out or misspelt, does not compile.
 *
 * Adding an action means adding it here, and to the table in README.md.
 *
 * Details are picked off the row types where they are a row's own columns,
 * so a column that changes type changes the entry with it.
 */
interface AuditEntryShapes {
  [AuditAction.MembershipRevived]: {
    subject: AuditSubjectType.CohortMember;
    details: {
      inviteId: string;
      invitedBy: string;
      /** The membership as it stood before the revive overwrote it. */
      previous: Pick<
        CohortMember,
        | 'role'
        | 'cohortTrackId'
        | 'status'
        | 'dismissalReason'
        | 'joinedAt'
        | 'leftAt'
        | 'accessExpiresAt'
      >;
    };
  };
  [AuditAction.SystemRoleChanged]: {
    subject: AuditSubjectType.User;
    details: {
      /** Null for an account created with the role it now has. */
      from: SystemRole | null;
      to: SystemRole;
    } & (
      | { inviteId: string; invitedBy: string } // an accepted invite granted it
      | { source: 'seed' } // the seed did, on nobody's behalf
    );
  };
  [AuditAction.InviteCreated]: {
    subject: AuditSubjectType.Invite;
    details: Pick<
      Invite,
      | 'cohortId'
      | 'cohortRole'
      | 'cohortTrackId'
      | 'systemRole'
      | 'expiresAt'
      | 'guestAccessExpiresAt'
    >;
  };
  [AuditAction.InviteRevoked]: {
    subject: AuditSubjectType.Invite;
    details: Pick<Invite, 'cohortId' | 'expiresAt'>;
  };
  [AuditAction.InviteFlagged]: {
    subject: AuditSubjectType.Invite;
    details: Pick<Invite, 'cohortId' | 'invitedBy'>;
  };
  [AuditAction.CohortCreated]: {
    subject: AuditSubjectType.Cohort;
    details: CohortSnapshot;
  };
  [AuditAction.CohortUpdated]: {
    subject: AuditSubjectType.Cohort;
    details: { changes: FieldChanges<keyof CohortSnapshot> };
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
    details: Pick<Track, 'name' | 'code'>;
  };
  [AuditAction.TrackUpdated]: {
    subject: AuditSubjectType.Track;
    details: { changes: FieldChanges<keyof TrackSnapshot> };
  };
  [AuditAction.TrackDeleted]: {
    subject: AuditSubjectType.Track;
    details: TrackSnapshot;
  };
}

/** What an admin can set on a cohort, and so what its entries record. */
type CohortSnapshot = Pick<
  Cohort,
  'name' | 'code' | 'status' | 'startDate' | 'endDate'
>;

/** The same for a track. */
type TrackSnapshot = Pick<Track, 'name' | 'code' | 'description'>;

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
export function changedFields<T extends object, K extends keyof T & string>(
  before: T,
  after: T,
  fields: readonly K[],
): FieldChanges<K> {
  const changes: FieldChanges<K> = {};
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
    // The id is whatever the caller sent in x-correlation-id. One too long
    // for the column would fail this insert and, sharing its transaction,
    // undo the change being recorded — so it is cut to fit instead. The
    // start of it still finds the request's log lines.
    correlationId:
      entry.correlationId?.slice(0, CORRELATION_ID_MAX_LENGTH) ?? null,
  });
}
