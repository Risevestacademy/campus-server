import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

export const googleCalendarGrants = pgTable(
  'google_calendar_grants',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Sealed with GOOGLE_CALENDAR_TOKEN_KEY, bound to user_id. */
    sealedRefreshToken: text('sealed_refresh_token').notNull(),
    /** Once set the grant is never used; the row goes when Google confirms. */
    revokeRequestedAt: timestamp('revoke_requested_at', {
      withTimezone: true,
    }),
    revokeAttempts: integer('revoke_attempts').notNull().default(0),
    revokeRetryAt: timestamp('revoke_retry_at', { withTimezone: true }),
    syncToken: text('sync_token'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** Held by whoever is syncing this grant; another sync waits behind it. */
    syncLeaseUntil: timestamp('sync_lease_until', { withTimezone: true }),
    /** A change arrived mid-sync: the holder syncs again before letting go. */
    syncPending: boolean('sync_pending').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('google_calendar_grants_revoke_requested_idx').on(
      table.revokeRequestedAt,
    ),
  ],
);

/** A Google push channel watching one grant's primary calendar. */
export const googleCalendarChannels = pgTable(
  'google_calendar_channels',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => googleCalendarGrants.userId, { onDelete: 'cascade' }),
    resourceId: varchar('resource_id', { length: 256 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('google_calendar_channels_user_idx').on(table.userId),
    index('google_calendar_channels_expires_idx').on(table.expiresAt),
  ],
);

export type CalendarChannel = typeof googleCalendarChannels.$inferSelect;
