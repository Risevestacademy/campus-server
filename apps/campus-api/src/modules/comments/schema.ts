import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

/**
 * What a comment is attached to. A plain string column and a named check,
 * rather than a database enum: project comments widen the list later by
 * changing this and the check, without an enum type to alter in a deployed
 * database.
 *
 * `target_id` is deliberately not a foreign key, for the same polymorphic
 * reason as a notification's reference: the target may be a notice now and a
 * project later, and a comment outlives the thing it is about.
 */
export enum CommentTargetType {
  Notice = 'notice',
}

export const COMMENT_BODY_MAX_LENGTH = 2000;

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** From the session, never from the request. */
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    /** The id of the row in the target table. Not a foreign key — see above. */
    targetId: uuid('target_id').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The list query: one target's comments in chronological order. The id
    // is the query's tie-break, so a page boundary never repeats or drops a
    // row with the same created_at.
    index('comments_target_created_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    // A typo cannot be written as a target type. Widen this with the project
    // comments work.
    check(
      'comments_target_type_known',
      sql`${table.targetType} in (${sql.raw(`'${CommentTargetType.Notice}'`)})`,
    ),
    // Something other than white space. The white space is spelt out, and is
    // the plain kind only: `\s` would mean whatever the database's locale
    // says, which is not what the request check means by it, and the two
    // disagreeing is a 500. The request check strips the rest first.
    check(
      'comments_body_not_blank',
      sql`${table.body} ~ '[^ \\t\\n\\r\\f\\v]'`,
    ),
    check(
      'comments_body_length',
      sql`length(${table.body}) <= ${sql.raw(String(COMMENT_BODY_MAX_LENGTH))}`,
    ),
  ],
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
