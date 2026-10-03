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
  /**
   * Deliberately beyond the TRD's four values: an admin cancelling a live
   * invite is not the same event as one lapsing, and squashing the two would
   * lose that distinction in the audit trail.
   */
  Revoked = 'revoked',
  Expired = 'expired',
}

export const inviteStatusEnum = pgEnum('invite_status', InviteStatus);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    /**
     * Null only for an admin invite — see invites_cohortless_is_admin.
     * system_role is independent of this, so an admin invite may still be
     * cohort-scoped — an admin who is also a professor on a cohort.
     */
    cohortId: uuid('cohort_id').references(() => cohorts.id),
    cohortTrackId: uuid('cohort_track_id'),
    /** No FK yet: mentorship_groups does not exist. */
    mentorshipGroupId: uuid('mentorship_group_id'),
    cohortRole: cohortRoleEnum('cohort_role'),
    systemRole: systemRoleEnum('system_role')
      .notNull()
      .default(SystemRole.User),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: inviteStatusEnum('status').notNull().default(InviteStatus.Pending),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * When the guest's access ends — not when this invite stops being
     * redeemable, which is expires_at above. Carried here because the admin
     * writing the invite is the one who knows the occasion.
     */
    guestAccessExpiresAt: timestamp('guest_access_expires_at', {
      withTimezone: true,
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /**
     * Who cancelled the invite, and when. Accepted/declined leave these null:
     * nobody cancels their own acceptance, so there is no actor to name. Kept
     * as columns as well as the invite_revoked audit entry, so the question
     * "who killed this offer" is answerable from the invite itself.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
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

    /**
     * Who and when travel together, and only on a revoked invite. One way
     * only: a revoked invite may carry neither, because 0002 revoked invites
     * on nobody's behalf, and history it wrote stays readable.
     */
    check(
      'invites_revoked_fields',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null) and (${table.revokedAt} is null or ${table.status} = ${sql.raw(`'${InviteStatus.Revoked}'`)})`,
    ),
    check(
      'invites_email_lowercase',
      sql`${table.email} = lower(${table.email})`,
    ),
    // A cohort and a role travel together: student, professor, mentor and
    // guest are all roles held in one cohort. Anything between is a row
    // nothing downstream can act on.
    check(
      'invites_cohort_pairing',
      sql`(${table.cohortId} is null) = (${table.cohortRole} is null)`,
    ),
    /**
     * Everybody who is not an admin is invited to a cohort — guests included,
     * since a guest is invited to one cohort and sees only that cohort.
     * Without this an invite could carry no cohort and no admin role, which
     * accepts into nothing: no membership, no role, and nothing for the
     * sign-in gate to tell its holder from a stranger by.
     *
     * Scoped to pending rows. The rule is about what may still be offered,
     * and databases predating this constraint hold settled invites of the
     * old cohort-less shape — refusing to keep a record of something that
     * did happen would mean deleting history to satisfy a rule about the
     * future. 0002 revokes the pending ones and leaves the rest readable.
     */
    check(
      'invites_cohortless_is_admin',
      sql`${table.status} is distinct from ${sql.raw(`'${InviteStatus.Pending}'`)} or ${table.cohortId} is not null or ${table.systemRole} = ${sql.raw(`'${SystemRole.Admin}'`)}`,
    ),
    // A guest invite has to say when the visit ends, because the membership
    // it creates cannot exist without one.
    check(
      'invites_guest_has_expiry',
      sql`(${table.cohortRole}::text is distinct from ${sql.raw(`'${CohortRole.Guest}'`)}) = (${table.guestAccessExpiresAt} is null)`,
    ),
    // A NULL cohort_id makes the composite FK above skip its check entirely
    // (MATCH SIMPLE), so the scoped columns need a cohort of their own accord.
    check(
      'invites_scoped_fields_require_cohort',
      sql`${table.cohortId} is not null or (${table.cohortTrackId} is null and ${table.mentorshipGroupId} is null)`,
    ),
    check(
      'invites_student_requires_track',
      sql`${table.cohortRole} is distinct from ${sql.raw(`'${CohortRole.Student}'`)} or ${table.cohortTrackId} is not null`,
    ),
  ],
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
