import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohortTracks, cohorts } from '../cohorts/schema.js';
import { spaces } from '../maps/schema.js';
import { mentorshipGroups } from '../mentorship-groups/schema.js';
import { users } from '../users/schema.js';

/** Whose event a link is for: the students expected at it. */
export enum RoomLinkAudience {
  Cohort = 'cohort',
  CohortTrack = 'cohort-track',
  MentorshipGroup = 'mentorship-group',
}

/**
 * A short link to a space in one cohort's campus, made for one event. When
 * the event runs comes from its synced runs, `room_link_instances`.
 * Revoking sets revoked_at; the row stays.
 */
export const roomLinks = pgTable(
  'room_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 16 }).notNull(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    /** The event the link was made for. */
    title: varchar('title', { length: 128 }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    audience: varchar('audience', { length: 16 })
      .$type<RoomLinkAudience>()
      .notNull()
      .default(RoomLinkAudience.Cohort),
    /** Set for `cohort-track`; cleared on a revoked link when its track is detached. */
    cohortTrackId: uuid('cohort_track_id'),
    /** Set for `mentorship-group`; cleared on a revoked link when its group is deleted. */
    mentorshipGroupId: uuid('mentorship_group_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.cohortTrackId, table.cohortId],
      foreignColumns: [cohortTracks.id, cohortTracks.cohortId],
      name: 'room_links_cohort_track_fk',
    }),
    foreignKey({
      columns: [table.mentorshipGroupId, table.cohortId],
      foreignColumns: [mentorshipGroups.id, mentorshipGroups.cohortId],
      name: 'room_links_mentorship_group_fk',
    }),
    check(
      'room_links_audience_known',
      sql`${table.audience} in (${sql.raw(
        Object.values(RoomLinkAudience)
          .map((a) => `'${a}'`)
          .join(', '),
      )})`,
    ),
    // A live link aimed at a track or a pod names it. A revoked one may have
    // lost it to a detach or a delete.
    check(
      'room_links_track_matches_audience',
      sql`(${table.cohortTrackId} is null or ${table.audience} = ${sql.raw(`'${RoomLinkAudience.CohortTrack}'`)}) and (${table.audience} <> ${sql.raw(`'${RoomLinkAudience.CohortTrack}'`)} or ${table.cohortTrackId} is not null or ${table.revokedAt} is not null)`,
    ),
    check(
      'room_links_group_matches_audience',
      sql`(${table.mentorshipGroupId} is null or ${table.audience} = ${sql.raw(`'${RoomLinkAudience.MentorshipGroup}'`)}) and (${table.audience} <> ${sql.raw(`'${RoomLinkAudience.MentorshipGroup}'`)} or ${table.mentorshipGroupId} is not null or ${table.revokedAt} is not null)`,
    ),
    index('room_links_cohort_track_idx').on(table.cohortTrackId),
    index('room_links_mentorship_group_idx').on(table.mentorshipGroupId),
    uniqueIndex('room_links_code_unique').on(table.code),
    index('room_links_cohort_space_idx').on(table.cohortId, table.spaceId),
    check(
      'room_links_revoke_window',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

/**
 * Somebody who opened a link while one of its runs was open. World lets them
 * into the link's space, in the link's cohort, whenever a run is open.
 */
export const roomLinkPasses = pgTable(
  'room_link_passes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomLinkId: uuid('room_link_id')
      .notNull()
      .references(() => roomLinks.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('room_link_passes_link_user_unique').on(
      table.roomLinkId,
      table.userId,
    ),
  ],
);

export type RoomLink = typeof roomLinks.$inferSelect;
export type NewRoomLink = typeof roomLinks.$inferInsert;
export type RoomLinkPass = typeof roomLinkPasses.$inferSelect;

/**
 * One run of a room link's event, synced from its organiser's Google
 * Calendar. Keyed by the organiser and Google's event id, which for a
 * recurring event names one instance and survives it being moved.
 */
export const roomLinkInstances = pgTable(
  'room_link_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomLinkId: uuid('room_link_id')
      .notNull()
      .references(() => roomLinks.id),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => users.id),
    googleEventId: varchar('google_event_id', { length: 1024 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('room_link_instances_event_unique').on(
      table.organizerId,
      table.googleEventId,
    ),
    index('room_link_instances_link_start_idx').on(
      table.roomLinkId,
      table.startsAt,
    ),
    check(
      'room_link_instances_window',
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

export type RoomLinkInstance = typeof roomLinkInstances.$inferSelect;
export type NewRoomLinkInstance = typeof roomLinkInstances.$inferInsert;
