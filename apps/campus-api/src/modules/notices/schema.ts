import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohortTracks, cohorts } from '../cohorts/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import { users } from '../users/schema.js';

/**
 * Who a notice is for. A plain string column rather than a database enum:
 * a fourth scope is a code change here and nothing else, with no migration
 * to write and no type to alter in a deployed database.
 */
export enum NoticeScope {
  /** Every member of the campus, whichever cohort they belong to. */
  Campus = 'campus',
  /** One cohort's members. */
  Cohort = 'cohort',
  /** The people walking one track of one cohort. */
  CohortTrack = 'cohort-track',
  /** One mentor's pod: the mentor and their students. */
  MentorshipGroup = 'mentorship-group',
}

/**
 * A staff announcement. The scope says who may read it, and the cohort and
 * track columns say the same thing twice — deliberately, so the list query
 * filters on an indexed column instead of parsing the scope, and so the
 * references a permission check needs are a foreign key away.
 *
 * The pairing rules are check constraints rather than service checks: a
 * write that skips the service must not be able to file a campus notice
 * under a cohort, which would hand it to the wrong readers.
 */
export const notices = pgTable(
  'notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    scope: varchar('scope', { length: 16 }).notNull(),
    /** Set for `cohort` and `cohort-track`; null for `campus`. */
    cohortId: uuid('cohort_id').references(() => cohorts.id),
    /** Set for `cohort-track` only — see notices_cohort_track_fk. */
    cohortTrackId: uuid('cohort_track_id'),
    /** Set for `mentorship-group` only — see notices_mentorship_group_fk. */
    mentorshipGroupId: uuid('mentorship_group_id'),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The track must belong to the cohort the notice is scoped to. The same
    // composite foreign key invites and space memberships use: cohort_tracks
    // is the only place a track and a cohort meet, so it is the only target
    // that can prove the pairing.
    foreignKey({
      columns: [table.cohortTrackId, table.cohortId],
      foreignColumns: [cohortTracks.id, cohortTracks.cohortId],
      name: 'notices_cohort_track_fk',
    }),
    // The group must belong to the notice's cohort. Groups are hard-deleted,
    // and a gone group's notices have nobody left to read them.
    foreignKey({
      columns: [table.mentorshipGroupId, table.cohortId],
      foreignColumns: [mentorshipGroups.id, mentorshipGroups.cohortId],
      name: 'notices_mentorship_group_fk',
    }).onDelete('cascade'),
    // Campus reaches everybody, so it names no cohort; every other scope
    // exists to address one, so it must.
    check(
      'notices_cohort_matches_scope',
      sql`(${table.scope} = ${sql.raw(`'${NoticeScope.Campus}'`)}) = (${table.cohortId} is null)`,
    ),
    // Only a track-scoped notice names a track. A cohort notice that named
    // one would read as reaching that track alone on a wall that filters by
    // cohort.
    check(
      'notices_track_matches_scope',
      sql`(${table.scope} = ${sql.raw(`'${NoticeScope.CohortTrack}'`)}) = (${table.cohortTrackId} is not null)`,
    ),
    check(
      'notices_group_matches_scope',
      sql`(${table.scope} = ${sql.raw(`'${NoticeScope.MentorshipGroup}'`)}) = (${table.mentorshipGroupId} is not null)`,
    ),
    index('notices_mentorship_group_idx').on(table.mentorshipGroupId),
    // The wall's list query: newest first within a scope.
    index('notices_scope_created_idx').on(table.scope, table.createdAt),
    // Reads filtered to one cohort — the notice wall for a member's cohort.
    index('notices_cohort_idx').on(table.cohortId),
  ],
);

export type Notice = typeof notices.$inferSelect;
export type NewNotice = typeof notices.$inferInsert;

/** The columns that say who a notice reaches. */
export type NoticeTarget = Pick<
  Notice,
  'scope' | 'cohortId' | 'cohortTrackId' | 'mentorshipGroupId'
>;
