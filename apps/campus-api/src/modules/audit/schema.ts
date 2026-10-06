import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { CORRELATION_ID_MAX_LENGTH } from '../../shared/http/correlation-id.js';
import { users } from '../users/schema.js';

/**
 * What happened. Stored as varchar rather than a Postgres enum so adding an
 * action is a code change, not a migration — the log outlives any one list
 * of things worth recording.
 */
export enum AuditAction {
  /**
   * A membership that had ended was brought back by an accepted invite.
   * `details.previous` keeps the row as it stood, dismissal reason included,
   * because the revive clears it from cohort_members.
   */
  MembershipRevived = 'membership_revived',
  /** An account's system_role changed; `details` has `from` and `to`. */
  SystemRoleChanged = 'system_role_changed',
  /**
   * An admin offered somebody a place. `details` has what was offered — the
   * cohort, the roles — and never the address, which stays on the invite.
   */
  InviteCreated = 'invite_created',
  /**
   * The three below are the admin setup an invite depends on. None of their
   * tables names who created the row, so the entry is the only record of it.
   */
  CohortCreated = 'cohort_created',
  CohortTrackAttached = 'cohort_track_attached',
  TrackCreated = 'track_created',
  /**
   * An admin edited a cohort or a track. `details.changes` maps each field
   * that actually moved to its `from` and `to`; an edit that moved nothing
   * writes no entry.
   */
  CohortUpdated = 'cohort_updated',
  TrackUpdated = 'track_updated',
  /**
   * An admin deleted a cohort or a track. The row is gone, so `details`
   * keeps what it was — the entry is the only trace left of it.
   */
  CohortDeleted = 'cohort_deleted',
  TrackDeleted = 'track_deleted',
  /**
   * An admin withdrew a pending invite. The invite's own revoked_by and
   * revoked_at say who and when; the entry adds the request it came from
   * and keeps the revoke in the same history as the create.
   */
  InviteRevoked = 'invite_revoked',
  /**
   * The invitee flagged a mistake on their invite. The actor is the invitee,
   * and what they wrote stays on the invite, not here.
   */
  InviteFlagged = 'invite_flagged',
  /**
   * An admin gave an invite a new link, replacing a live one or bringing
   * back an invite that had lapsed. `details` has the deadline before and
   * after, and never the address or anything of the token.
   */
  InviteResent = 'invite_resent',
  /**
   * An admin moved a guest's visit deadline forward. `details` has the
   * deadline before and after; the subject says which membership, so who
   * and where are read from the row rather than repeated here.
   */
  GuestVisitExtended = 'guest_visit_extended',
}

export enum AuditSubjectType {
  CohortMember = 'cohort_member',
  User = 'user',
  Invite = 'invite',
  Cohort = 'cohort',
  CohortTrack = 'cohort_track',
  Track = 'track',
}

/**
 * Append-only: nothing updates or deletes a row. Written in the same
 * transaction as the change it records, so a change is never committed
 * without its entry, nor an entry without its change.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null when no person did it: a migration, the seed, a sweep. */
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: varchar('action', { length: 64 }).notNull(),
    subjectType: varchar('subject_type', { length: 64 }),
    subjectId: uuid('subject_id'),
    /** No FK yet: spaces does not exist. */
    spaceId: uuid('space_id'),
    details: jsonb('details'),
    /**
     * The request's correlation id, so an entry leads to its log lines. As
     * wide as the longest id a request may bring, so it is stored whole.
     */
    correlationId: varchar('correlation_id', {
      length: CORRELATION_ID_MAX_LENGTH,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_log_created_idx').on(table.createdAt),
    index('audit_log_actor_idx').on(table.actorUserId, table.createdAt),
    // "Everything that happened to this membership" is the question a
    // subject's history is read for.
    index('audit_log_subject_idx').on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
