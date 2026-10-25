import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

/** A member's standing permission to read their Google Calendar. */
export const googleCalendarGrants = pgTable('google_calendar_grants', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Google's refresh token, sealed with GOOGLE_CALENDAR_TOKEN_KEY. */
  sealedRefreshToken: text('sealed_refresh_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GoogleCalendarGrantRow = typeof googleCalendarGrants.$inferSelect;
