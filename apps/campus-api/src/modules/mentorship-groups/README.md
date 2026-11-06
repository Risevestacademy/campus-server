# Mentorship groups

A pod inside one cohort: one mentor, a set of students, and a name. The routes
are admin-only and live under
`/v1/cohorts/{cohortId}/mentorship-groups`.

## Decisions

- **One group per student per cohort.** `mentorship_group_students` has a
  unique `(cohort_id, cohort_member_id)`. A student may be in groups in
  different cohorts, but not two in the same one.
- **One group per mentor per cohort.** `mentorship_groups` has a unique
  `(cohort_id, mentor_member_id)`. A mentor may lead groups in different
  cohorts.
- **A group always has a mentor.** Ending a mentor's cohort membership while
  they lead a group is refused with a 409; the admin reassigns the group first.
  The group and student links are not deleted or repointed automatically.
- **A student who leaves the cohort leaves the group.** Ending a student's
  cohort membership deletes their group link in the same transaction. It is
  not a separate audit entry: `membership_ended` records the end, and the group
  link is a consequence of it.
- **Empty groups are allowed.** A group can be created before students are
  assigned.
- **Names are unique per cohort, ignoring case.** `Pod A` and `pod a` collide.
  The name is trimmed and at most 128 characters.
- **A group invite is a student invite.** `invites.mentorship_group_id` may
  only be set with `cohortRole = student`, and the group must belong to the
  invite's cohort. Accepting the invite enrols the student and puts them in the
  group in the same transaction.
- **A group can be deleted.** Deleting it removes its student links; the
  students stay in the cohort. Settled invites keep their row but have the
  group id cleared. It is refused while a pending invite still names it, or
  while a live entry on a space's list names it — end that entry first. Ended
  entries go with the group, and the delete's audit entry names them, as a
  detached track's does. A cohort with groups cannot be deleted until its
  groups are deleted, like cohorts with tracks or invites.

## Constraints

The person references are cohort memberships, not user ids. Two composite
foreign keys carry the role rules, with generated constant role columns so a
plain foreign key can compare against `'mentor'` and `'student'`:

- `mentorship_groups_mentor_in_cohort` — the mentor membership is in the
  group's cohort and its role is `mentor`.
- `mentorship_group_students_student_in_cohort` — the student membership is in
  the student link's cohort and its role is `student`.

The rest of the named constraints are in
`apps/campus-api/src/infra/database/migrations/0020_mentorship_groups.sql`.
The database tests assert each rule by name in
`src/infra/database/schema.spec.ts`.
