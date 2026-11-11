import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { roomLinkInstances } from '../room-links/schema.js';
import { users } from '../users/schema.js';

export enum AttendanceStatus {
  Present = 'present',
  Partial = 'partial',
  Absent = 'absent',
}

export enum AttendanceSource {
  Derived = 'derived',
  Override = 'override',
}

export const attendanceStatusEnum = pgEnum(
  'attendance_status',
  AttendanceStatus,
);
export const attendanceSourceEnum = pgEnum(
  'attendance_source',
  AttendanceSource,
);

/**
 * A run of a room link's event, as it was when attendance was worked out.
 * The window is kept so a run moved in Google afterwards is tallied again,
 * and so a percentage has the length it was measured against.
 */
export const attendanceTallies = pgTable(
  'attendance_tallies',
  {
    instanceId: uuid('instance_id')
      .primaryKey()
      .references(() => roomLinkInstances.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    talliedAt: timestamp('tallied_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'attendance_tallies_window',
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      'attendance_tallies_after_end',
      sql`${table.talliedAt} >= ${table.endsAt}`,
    ),
  ],
);

/**
 * One expected student at one run. present_seconds is their time in the
 * space's call inside the run, as measured; a correction changes the status
 * and leaves it alone.
 */
export const attendance = pgTable(
  'attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => attendanceTallies.instanceId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    presentSeconds: integer('present_seconds').notNull(),
    status: attendanceStatusEnum('status').notNull(),
    source: attendanceSourceEnum('source')
      .notNull()
      .default(AttendanceSource.Derived),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('attendance_instance_user_unique').on(
      table.instanceId,
      table.userId,
    ),
    index('attendance_user_idx').on(table.userId),
    check('attendance_present_seconds', sql`${table.presentSeconds} >= 0`),
  ],
);

/**
 * Every staff correction, append-only. Attendance can count towards a
 * dismissal, so each change keeps who made it, when and why.
 */
export const attendanceOverrides = pgTable(
  'attendance_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attendanceId: uuid('attendance_id')
      .notNull()
      .references(() => attendance.id),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    oldStatus: attendanceStatusEnum('old_status').notNull(),
    newStatus: attendanceStatusEnum('new_status').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('attendance_overrides_attendance_idx').on(table.attendanceId),
    check(
      'attendance_overrides_reason_not_blank',
      sql`btrim(${table.reason}) <> ''`,
    ),
  ],
);

/** A run whose tally failed, so it waits longer each time before another try. */
export const attendanceTallyFailures = pgTable('attendance_tally_failures', {
  instanceId: uuid('instance_id')
    .primaryKey()
    .references(() => roomLinkInstances.id),
  attempts: integer('attempts').notNull().default(1),
  lastFailedAt: timestamp('last_failed_at', { withTimezone: true }).notNull(),
});

export type AttendanceTally = typeof attendanceTallies.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type NewAttendance = typeof attendance.$inferInsert;
export type AttendanceOverride = typeof attendanceOverrides.$inferSelect;
