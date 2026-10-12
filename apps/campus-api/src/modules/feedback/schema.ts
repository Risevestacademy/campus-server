import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohorts } from '../cohorts/schema.js';
import { users } from '../users/schema.js';

/**
 * What a member is telling the people who run the campus: something is
 * broken, something could be better, or somebody did something they should
 * not have.
 */
export enum FeedbackType {
  Bug = 'bug',
  Idea = 'idea',
  Report = 'report',
}

/** Whether an admin has dealt with it. Nothing else: this is not a ticket. */
export enum FeedbackStatus {
  Open = 'open',
  Resolved = 'resolved',
}

export const feedbackTypeEnum = pgEnum('feedback_type', FeedbackType);
export const feedbackStatusEnum = pgEnum('feedback_status', FeedbackStatus);

export const FEEDBACK_TITLE_MAX_LENGTH = 120;
export const FEEDBACK_DETAILS_MAX_LENGTH = 4000;
export const FEEDBACK_ABOUT_MAX_LENGTH = 200;
export const FEEDBACK_USER_AGENT_MAX_LENGTH = 512;

/**
 * Where a member was when they sent it, as their client reported it. Saved
 * as given and trusted for nothing: it is a hint for whoever reads a bug,
 * not a record of where anybody stood.
 */
export interface FeedbackContext {
  /** The page or screen, e.g. `/campus`. */
  path?: string;
  mapId?: string;
  mapVersion?: string;
  /** The tile they stood on, when they were on a map. */
  x?: number;
  y?: number;
}

export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: feedbackTypeEnum('type').notNull(),
    title: varchar('title', { length: FEEDBACK_TITLE_MAX_LENGTH }).notNull(),
    details: text('details').notNull(),
    /**
     * Who or where, in the member's words: who a report is about, where a
     * bug happened. Asked for on every type and required on none.
     */
    about: varchar('about', { length: FEEDBACK_ABOUT_MAX_LENGTH }),
    /**
     * The account a report is about, when the member picked a person rather
     * than typing a name. Reports only.
     */
    reportedUserId: uuid('reported_user_id').references(() => users.id),
    /** From the session, never from the request. */
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    /**
     * The cohort they were in at the time, if their client said. A hint and
     * nothing more, so it never holds a cohort in place: deleting the cohort
     * empties this.
     */
    cohortId: uuid('cohort_id').references(() => cohorts.id, {
      onDelete: 'set null',
    }),
    context: jsonb('context').$type<FeedbackContext>(),
    /** The browser or app that sent it, from the request's own header. */
    userAgent: varchar('user_agent', {
      length: FEEDBACK_USER_AGENT_MAX_LENGTH,
    }),
    status: feedbackStatusEnum('status').notNull().default(FeedbackStatus.Open),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The admin's list: newest first, usually narrowed to a type that is
    // still open.
    index('feedback_created_idx').on(table.createdAt),
    index('feedback_type_status_idx').on(
      table.type,
      table.status,
      table.createdAt,
    ),
    // How many somebody has sent lately, asked on every send.
    index('feedback_submitted_by_idx').on(table.submittedBy, table.createdAt),
    // Something other than white space. The white space is spelt out, and
    // is the plain kind only: `\s` would mean whatever the database's
    // locale says, which is not what the request check means by it, and the
    // two disagreeing is a 500. The request check strips the rest first.
    check(
      'feedback_title_not_blank',
      sql`${table.title} ~ '[^ \\t\\n\\r\\f\\v]'`,
    ),
    check(
      'feedback_details_not_blank',
      sql`${table.details} ~ '[^ \\t\\n\\r\\f\\v]'`,
    ),
    check(
      'feedback_details_length',
      sql`length(${table.details}) <= ${sql.raw(String(FEEDBACK_DETAILS_MAX_LENGTH))}`,
    ),
    // Naming an account is an accusation. Only a report makes one.
    check(
      'feedback_reported_user_on_reports',
      sql`${table.reportedUserId} is null or ${table.type} = ${sql.raw(`'${FeedbackType.Report}'`)}`,
    ),
    // Resolved by somebody, at some time, or not resolved: never half of it.
    check(
      'feedback_resolution',
      sql`(${table.status} = ${sql.raw(`'${FeedbackStatus.Resolved}'`)}) = (${table.resolvedAt} is not null) and (${table.resolvedAt} is null) = (${table.resolvedBy} is null)`,
    ),
  ],
);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
