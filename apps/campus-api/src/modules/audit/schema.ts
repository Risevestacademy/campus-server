import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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
    /** The request's x-correlation-id, so an entry leads to its log lines. */
    correlationId: varchar('correlation_id', { length: 64 }),
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
