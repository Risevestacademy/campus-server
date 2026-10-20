import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohorts } from '../cohorts/schema.js';
import { spaces } from '../maps/schema.js';
import { users } from '../users/schema.js';

/*
 * The record of calls. A session is one call in a space, from the moment it
 * opens to the moment it closes; a participant row is one person's time in
 * it. Neither says who is in a call right now with any authority: that is
 * the media server's to know. These are what is left once it is over.
 */

/** Who carries the audio and video. The only place the provider is named. */
export enum MediaProvider {
  LiveKit = 'livekit',
}

export const mediaProviderEnum = pgEnum('media_provider', MediaProvider);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The campus the call is held in. Every cohort walks the same map, but
     * each is its own campus: the library in one is not the library in
     * another.
     */
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    provider: mediaProviderEnum('provider')
      .notNull()
      .default(MediaProvider.LiveKit),
    /** The provider's name for the room the call runs in. */
    providerRoomId: varchar('provider_room_id', { length: 128 }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while the call is open. There is no status column: this is it. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_cohort_idx').on(table.cohortId),
    index('sessions_space_idx').on(table.spaceId),
    // Everybody in a cohort's space is in the one call. Two open at once
    // would split the room between them. Other cohorts in the same space
    // are in calls of their own.
    uniqueIndex('sessions_one_open_per_cohort_space')
      .on(table.cohortId, table.spaceId)
      .where(sql`${table.closedAt} is null`),
    check(
      'sessions_closed_after_opened',
      sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`,
    ),
  ],
);

export const sessionParticipants = pgTable(
  'session_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while they are still in the call. */
    leftAt: timestamp('left_at', { withTimezone: true }),
    /**
     * Whether they turned their camera on at any point. Off unless they did:
     * a row that cannot say is recorded as off, never as unknown.
     */
    videoEnabled: boolean('video_enabled').notNull().default(false),
  },
  (table) => [
    index('session_participants_session_idx').on(table.sessionId),
    index('session_participants_user_idx').on(table.userId),
    // An account has one world connection per cohort, so it is in a call
    // once. Somebody who leaves and comes back gets a new row.
    uniqueIndex('session_participants_one_open_per_person')
      .on(table.sessionId, table.userId)
      .where(sql`${table.leftAt} is null`),
    check(
      'session_participants_left_after_joined',
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

// Named for calls, not sessions: a session elsewhere in the API is a sign-in.
export type CallSession = typeof sessions.$inferSelect;
export type NewCallSession = typeof sessions.$inferInsert;
export type CallParticipant = typeof sessionParticipants.$inferSelect;
export type NewCallParticipant = typeof sessionParticipants.$inferInsert;
