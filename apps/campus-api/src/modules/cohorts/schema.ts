import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';

export enum CohortRole {
  Student = 'student',
  Professor = 'professor',
  Mentor = 'mentor',
}

export enum CohortStatus {
  Upcoming = 'upcoming',
  Active = 'active',
  Completed = 'completed',
}

export enum StudentStatus {
  Active = 'active',
  Dismissed = 'dismissed',
  Graduated = 'graduated',
}

export const cohortRoleEnum = pgEnum('cohort_role', CohortRole);
export const studentStatusEnum = pgEnum('student_status', StudentStatus);
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
  (table) => [
    uniqueIndex('cohorts_code_unique').on(table.code),
    check('cohorts_code_uppercase', sql`${table.code} = upper(${table.code})`),
  ],
);

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
    unique('cohort_tracks_track_id_cohort_id_key').on(
      table.trackId,
      table.cohortId,
    ),
    unique('cohort_tracks_id_cohort_id_key').on(table.id, table.cohortId),
  ],
);

export const cohortMembers = pgTable(
  'cohort_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Required for students — see the CHECK below. */
    cohortTrackId: uuid('cohort_track_id'),
    role: cohortRoleEnum('role').notNull(),
    status: studentStatusEnum('status'),
    dismissalReason: text('dismissal_reason'),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The track has to belong to the cohort the membership is in.
    foreignKey({
      columns: [table.cohortTrackId, table.cohortId],
      foreignColumns: [cohortTracks.id, cohortTracks.cohortId],
      name: 'cohort_members_cohort_track_fk',
    }),
    // One live membership per person per cohort; leaving and rejoining later
    // is still allowed because a closed row has left_at set.
    uniqueIndex('cohort_members_active_unique')
      .on(table.cohortId, table.userId)
      .where(sql`${table.leftAt} is null`),
    check(
      'cohort_members_student_requires_track',
      sql`${table.role} is distinct from ${sql.raw(`'${CohortRole.Student}'`)} or ${table.cohortTrackId} is not null`,
    ),

    check(
      'cohort_members_student_fields',
      sql`(${table.role} = ${sql.raw(`'${CohortRole.Student}'`)} and ${table.status} is not null) or (${table.role} <> ${sql.raw(`'${CohortRole.Student}'`)} and ${table.status} is null and ${table.dismissalReason} is null)`,
    ),
  ],
);

export type Cohort = typeof cohorts.$inferSelect;
export type NewCohort = typeof cohorts.$inferInsert;
export type CohortTrack = typeof cohortTracks.$inferSelect;
export type NewCohortTrack = typeof cohortTracks.$inferInsert;
export type CohortMember = typeof cohortMembers.$inferSelect;
export type NewCohortMember = typeof cohortMembers.$inferInsert;
