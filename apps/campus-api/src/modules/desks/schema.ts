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

import { cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps } from '../maps/schema.js';
import { users } from '../users/schema.js';

/** Why a claim on a desk ended. */
export enum DeskReleaseReason {
  /** The holder let it go. */
  Released = 'released',
  FreedByAdmin = 'freed_by_admin',
  /** The holder's membership of the cohort ended. */
  EnrolmentEnded = 'enrolment_ended',
  /** The desk is no longer on the published map. */
  DeskRetired = 'desk_retired',
}

export const deskReleaseReasonEnum = pgEnum(
  'desk_release_reason',
  DeskReleaseReason,
);

/**
 * A desk drawn on a published map, by key. Where it stands and which space
 * it sits in stay with the map, as a space's bounds do. Created and retired
 * by the map sync only.
 */
export const desks = pgTable(
  'desks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mapId: uuid('map_id')
      .notNull()
      .references(() => maps.id),
    /** The object's name in Tiled, unique across every map. */
    key: varchar('key', { length: 64 }).notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Retired or not: a key that comes back is the same desk.
    uniqueIndex('desks_key_unique').on(table.key),
  ],
);

/**
 * Who holds a desk, per cohort: each cohort's copy of the campus has its own
 * holder for a desk, and a person holds at most one desk in each cohort they
 * are in. Ending a claim sets released_at; the row stays as history.
 */
export const deskClaims = pgTable(
  'desk_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deskId: uuid('desk_id')
      .notNull()
      .references(() => desks.id),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: deskReleaseReasonEnum('release_reason'),
  },
  (table) => [
    // Only members of the cohort hold its desks.
    foreignKey({
      columns: [table.cohortId, table.userId],
      foreignColumns: [cohortMembers.cohortId, cohortMembers.userId],
      name: 'desk_claims_cohort_member_fk',
    }),
    uniqueIndex('desk_claims_one_holder')
      .on(table.deskId, table.cohortId)
      .where(sql`${table.releasedAt} is null`),
    uniqueIndex('desk_claims_one_desk')
      .on(table.userId, table.cohortId)
      .where(sql`${table.releasedAt} is null`),
    check(
      'desk_claims_release_reason',
      sql`(${table.releasedAt} is null) = (${table.releaseReason} is null)`,
    ),
    check(
      'desk_claims_release_window',
      sql`${table.releasedAt} is null or ${table.releasedAt} >= ${table.claimedAt}`,
    ),
  ],
);

export type Desk = typeof desks.$inferSelect;
export type NewDesk = typeof desks.$inferInsert;
export type DeskClaim = typeof deskClaims.$inferSelect;
export type NewDeskClaim = typeof deskClaims.$inferInsert;
