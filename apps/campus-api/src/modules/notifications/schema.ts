import {
  pgTable,
  index,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

/**
 * One alert for one person.
 *
 * `kind` and the reference pair are plain strings on purpose. Kinds are
 * added as the events they report are — `notice_posted`,
 * `entry_request_answered`, `meeting_starting` — so a new one needs a code
 * change and no migration, and the reference points at whatever row
 * triggered this: a notice, an entry request, a calendar event.
 *
 * There is no foreign key on the reference, for the same reason: the
 * referenced row may be in any table, and a notification is the record that
 * something happened to somebody — it has to outlive the thing it points at.
 * Deleting a notice must not take the "your notice was posted" alert with
 * it.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id),
    /** What happened, e.g. `notice_posted`. */
    kind: varchar('kind', { length: 64 }).notNull(),
    /** Which table the event happened in, e.g. `notice`, `calendar_event`. */
    referenceType: varchar('reference_type', { length: 64 }).notNull(),
    /** The id of the row in that table. Not a foreign key — see above. */
    referenceId: uuid('reference_id').notNull(),
    /** Null until the recipient marks it read. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The list query: one person's alerts, newest first.
    index('notifications_recipient_created_idx').on(
      table.recipientId,
      table.createdAt,
    ),
    // One alert per person per event. Retries, a re-posted notice and a
    // retried transaction all land here rather than on the recipient's
    // badge twice.
    uniqueIndex('notifications_recipient_kind_reference_unique').on(
      table.recipientId,
      table.kind,
      table.referenceType,
      table.referenceId,
    ),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
