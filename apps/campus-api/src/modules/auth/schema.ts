import {
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('refresh_tokens_token_hash_unique').on(table.tokenHash)],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;