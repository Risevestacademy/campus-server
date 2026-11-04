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
  },
  (table) => [
    uniqueIndex('room_links_code_unique').on(table.code),
    index('room_links_cohort_space_idx').on(table.cohortId, table.spaceId),
    check(
      'room_links_revoke_window',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type RoomLink = typeof roomLinks.$inferSelect;
export type NewRoomLink = typeof roomLinks.$inferInsert;
