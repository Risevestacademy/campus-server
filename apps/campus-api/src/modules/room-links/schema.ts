import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohorts } from '../cohorts/schema.js';
import { spaces } from '../maps/schema.js';
import { users } from '../users/schema.js';

/**
 * A short link to a space in one cohort's campus, made for one event. A space
 * may have any number of live links at once. Revoking sets revoked_at; the
 * row stays.
 *
 * The window is when the event runs. Whoever opens the link during it, or
 * shortly before, may enter the space until it ends.
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
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('room_links_code_unique').on(table.code),
    index('room_links_cohort_space_idx').on(table.cohortId, table.spaceId),
    check(
      'room_links_revoke_window',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check(
      'room_links_window',
      sql`(${table.startsAt} is null and ${table.endsAt} is null) or (${table.startsAt} is not null and ${table.endsAt} is not null and ${table.endsAt} > ${table.startsAt})`,
    ),
  ],
);

/**
 * Somebody who opened a link while its window was open. World lets them into
 * the link's space, in the link's cohort, for as long as the window runs, so
 * a window moved later moves the pass with it.
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
