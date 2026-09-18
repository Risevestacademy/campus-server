import {
  date,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { tracks } from '../tracks/schema.js';

export enum CohortRole {
  Student = 'student',
  Professor = 'professor',
  Mentor = 'mentor',
}

/**
 * Kept deliberately lean — ALTER TYPE ... ADD VALUE is a one-liner, while
 * removing a value someone has already written to is not.
 */
export enum CohortStatus {
  Upcoming = 'upcoming',
  Active = 'active',
  Completed = 'completed',
}

export const cohortRoleEnum = pgEnum('cohort_role', CohortRole);
export const cohortStatusEnum = pgEnum('cohort_status', CohortStatus);

export const cohorts = pgTable(
  'cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name').notNull(),
    code: varchar('code').notNull(),
    startDate: date('start_date'),
    endDate: date('end_date'),
    status: cohortStatusEnum('status').notNull().default(CohortStatus.Upcoming),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('cohorts_code_unique').on(table.code)],
);

/** A track as it runs inside one cohort — what members are actually placed on. */
export const cohortTracks = pgTable(
  'cohort_tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // For postgres, so INVITES can point composite FK at (id, cohort_id)
    unique('cohort_tracks_id_cohort_id_key').on(table.id, table.cohortId),
  ],
);

export type Cohort = typeof cohorts.$inferSelect;
export type NewCohort = typeof cohorts.$inferInsert;
export type CohortTrack = typeof cohortTracks.$inferSelect;
export type NewCohortTrack = typeof cohortTracks.$inferInsert;
