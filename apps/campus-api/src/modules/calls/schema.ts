import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
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
    // One run of a LiveKit room is one session, however often it is heard of.
    uniqueIndex('sessions_provider_room_unique').on(table.providerRoomId),
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
    /**
     * Who they were to the media server. A fresh one each time they enter,
     * so the row a leave closes is the one that join opened.
     */
    providerIdentity: varchar('provider_identity', { length: 128 }).notNull(),
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
    // Fresh for every entry, so a retried join or leave finds the one row.
    uniqueIndex('session_participants_provider_identity_unique').on(
      table.providerIdentity,
    ),
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

export enum RecordingStatus {
  /** Asked of LiveKit, not yet heard to be under way. */
  Starting = 'starting',
  Active = 'active',
  /** Over, with its file in the bucket. */
  Complete = 'complete',
  /** Over with nothing usable saved, or never started. */
  Failed = 'failed',
}

export const recordingStatusEnum = pgEnum('recording_status', RecordingStatus);

/**
 * A recording of a call: one video of the whole room, which LiveKit uploads
 * to the bucket under `file_key`. Started and stopped by staff; never
 * deleted.
 */
export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id),
    /** Null when nobody stopped it: the call ended, or it failed. */
    stoppedBy: uuid('stopped_by').references(() => users.id),
    /** LiveKit's id for it; null until LiveKit has answered the start. */
    providerEgressId: varchar('provider_egress_id', { length: 128 }),
    /** Where the file is in the bucket. Fixed before LiveKit is asked. */
    fileKey: varchar('file_key', { length: 512 }).notNull(),
    status: recordingStatusEnum('status')
      .notNull()
      .default(RecordingStatus.Starting),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** LiveKit's reason, for a recording that failed. */
    error: text('error'),
  },
  (table) => [
    index('recordings_session_idx').on(table.sessionId),
    uniqueIndex('recordings_provider_egress_unique').on(table.providerEgressId),
    uniqueIndex('recordings_file_key_unique').on(table.fileKey),
    // One recording of a call at a time: a second would be the same video.
    uniqueIndex('recordings_one_live_per_session')
      .on(table.sessionId)
      .where(sql`${table.status} in ('starting', 'active')`),
    check(
      'recordings_ended_after_started',
      sql`${table.endedAt} is null or ${table.startedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      'recordings_measures_not_negative',
      sql`coalesce(${table.durationMs}, 0) >= 0 and coalesce(${table.sizeBytes}, 0) >= 0`,
    ),
  ],
);

// Named for calls, not sessions: a session elsewhere in the API is a sign-in.
export type CallSession = typeof sessions.$inferSelect;
export type NewCallSession = typeof sessions.$inferInsert;
export type CallParticipant = typeof sessionParticipants.$inferSelect;
export type NewCallParticipant = typeof sessionParticipants.$inferInsert;
export type CallRecording = typeof recordings.$inferSelect;
export type NewCallRecording = typeof recordings.$inferInsert;
