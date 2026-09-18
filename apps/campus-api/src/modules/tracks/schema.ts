import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const tracks = pgTable(
  'tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name').notNull(),
    code: varchar('code').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('tracks_code_unique').on(table.code),
    check('tracks_code_uppercase', sql`${table.code} = upper(${table.code})`),
  ],
);

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
