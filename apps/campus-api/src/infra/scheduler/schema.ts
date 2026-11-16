import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const scheduledJobs = pgTable('scheduled_jobs', {
  name: varchar('name', { length: 64 }).primaryKey(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
});
