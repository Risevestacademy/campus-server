import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  CohortRole,
  cohortRoleEnum,
  cohortTracks,
  cohorts,
} from '../cohorts/schema.js';
import { SystemRole, systemRoleEnum, users } from '../users/schema.js';

export enum InviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Revoked = 'revoked',
  Expired = 'expired',
}

export const inviteStatusEnum = pgEnum('invite_status', InviteStatus);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email').notNull(),
    /** Null for admin invites, which are not scoped to a cohort. */
    cohortId: uuid('cohort_id').references(() => cohorts.id),
    cohortTrackId: uuid('cohort_track_id'),
    /** No FK yet: mentorship_groups does not exist. */
    mentorshipGroupId: uuid('mentorship_group_id'),
    cohortRole: cohortRoleEnum('cohort_role'),
    systemRole: systemRoleEnum('system_role')
      .notNull()
      .default(SystemRole.User),
    tokenHash: varchar('token_hash').notNull(),
    status: inviteStatusEnum('status').notNull().default(InviteStatus.Pending),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The track must belong to the cohort the invite is scoped to.
    foreignKey({
      columns: [table.cohortTrackId, table.cohortId],
      foreignColumns: [cohortTracks.id, cohortTracks.cohortId],
      name: 'invites_cohort_track_fk',
    }),
    uniqueIndex('invites_token_hash_unique').on(table.tokenHash),
    // One live invite per address. Re-inviting means resolving the open one
    // first, so an address can never hold two contradictory pending offers.
    uniqueIndex('invites_email_pending_unique')
      .on(table.email)
      .where(sql`${table.status} = ${sql.raw(`'${InviteStatus.Pending}'`)}`),

    check(
      'invites_email_lowercase',
      sql`${table.email} = lower(${table.email})`,
    ),
    // Without this, a NULL cohort_id makes the composite FK above skip its
    // check (MATCH SIMPLE), so an invite could name a cohort_track that
    // belongs to nobody. Either an invite is cohort-scoped or it is not.
    check(
      'invites_cohort_scope',
      sql`${table.cohortId} is not null or (${table.cohortTrackId} is null and ${table.cohortRole} is null)`,
    ),
    check(
      'invites_student_requires_track',
      sql`${table.cohortRole} is distinct from ${sql.raw(`'${CohortRole.Student}'`)} or ${table.cohortTrackId} is not null`,
    ),
  ],
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
