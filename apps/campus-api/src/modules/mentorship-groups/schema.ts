import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { cohortMembers, cohortRoleEnum, cohorts } from '../cohorts/schema.js';

/**
 * A pod: one mentor and a set of students inside a cohort.
 *
 * The mentor and student rules are database constraints, not service checks.
 * A composite foreign key cannot compare a column against a constant, so the
 * two role columns are generated from that constant and the foreign keys
 * include them. That is what makes "a mentor of another cohort" or "a student
 * with a professor's membership" fail on a named constraint.
 */
export const mentorshipGroups = pgTable(
  'mentorship_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    mentorMemberId: uuid('mentor_member_id').notNull(),
    /** Always 'mentor'; part of mentorship_groups_mentor_in_cohort. */
    mentorRole: cohortRoleEnum('mentor_role')
      .notNull()
      .generatedAlwaysAs(sql`'mentor'::cohort_role`),
    name: varchar('name', { length: 128 }).notNull(),
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
    // The mentor is a member of this cohort, holding the mentor role.
    foreignKey({
      columns: [table.mentorMemberId, table.cohortId, table.mentorRole],
      foreignColumns: [
        cohortMembers.id,
        cohortMembers.cohortId,
        cohortMembers.role,
      ],
      name: 'mentorship_groups_mentor_in_cohort',
    }),
    // Target for mentorship_group_students' group-and-cohort foreign key.
    unique('mentorship_groups_id_cohort_id_key').on(table.id, table.cohortId),
    check('mentorship_groups_name_not_blank', sql`btrim(${table.name}) <> ''`),
    // One name per cohort, whatever its case. Renaming only changes case is
    // still a rename, so the index is on lower(name).
    uniqueIndex('mentorship_groups_cohort_name_unique').on(
      table.cohortId,
      sql`lower(${table.name})`,
    ),
    // One pod per mentor per cohort. Across cohorts is allowed.
    uniqueIndex('mentorship_groups_one_per_mentor').on(
      table.cohortId,
      table.mentorMemberId,
    ),
    index('mentorship_groups_cohort_idx').on(table.cohortId),
  ],
);

export const mentorshipGroupStudents = pgTable(
  'mentorship_group_students',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mentorshipGroupId: uuid('mentorship_group_id').notNull(),
    /**
     * Kept here so the student rule can be one composite foreign key. It is
     * also what makes "one group per student per cohort" a plain unique index.
     */
    cohortId: uuid('cohort_id').notNull(),
    cohortMemberId: uuid('cohort_member_id').notNull(),
    /** Always 'student'; part of mentorship_group_students_student_in_cohort. */
    memberRole: cohortRoleEnum('member_role')
      .notNull()
      .generatedAlwaysAs(sql`'student'::cohort_role`),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The group exists, and it belongs to the cohort named here.
    foreignKey({
      columns: [table.mentorshipGroupId, table.cohortId],
      foreignColumns: [mentorshipGroups.id, mentorshipGroups.cohortId],
      name: 'mentorship_group_students_group_fk',
    }),
    // The student is a member of the group's cohort, holding student role.
    foreignKey({
      columns: [table.cohortMemberId, table.cohortId, table.memberRole],
      foreignColumns: [
        cohortMembers.id,
        cohortMembers.cohortId,
        cohortMembers.role,
      ],
      name: 'mentorship_group_students_student_in_cohort',
    }),
    unique('mentorship_group_students_unique').on(
      table.mentorshipGroupId,
      table.cohortMemberId,
    ),
    // A student is in at most one group in a cohort.
    unique('mentorship_group_students_one_per_cohort').on(
      table.cohortId,
      table.cohortMemberId,
    ),
    index('mentorship_group_students_group_idx').on(table.mentorshipGroupId),
  ],
);

export type MentorshipGroup = typeof mentorshipGroups.$inferSelect;
export type NewMentorshipGroup = typeof mentorshipGroups.$inferInsert;
export type MentorshipGroupStudent =
  typeof mentorshipGroupStudents.$inferSelect;
export type NewMentorshipGroupStudent =
  typeof mentorshipGroupStudents.$inferInsert;
