# Attendance

Who was at each run of a room link's event, worked out from the record of
calls once the run has ended.

| Table                  | A row is                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `attendance_tallies`   | One run as it was tallied: its window, and when                                             |
| `attendance`           | One expected student at one run: seconds in the space's call inside the run, status, source |
| `attendance_overrides` | One staff correction, append-only: who, old and new status, and why                         |

## Tallying

The `attendance-tally` job runs every five minutes and takes runs that ended
at least five minutes ago, so late word from LiveKit of who left has arrived.

- **Expected students** are the students of the link's cohort who had joined
  it by the run's start and had not left: all of them, one track's, or one
  pod's, as the link's audience says. Staff and guests get no rows.
- **Time** is time in the cohort's call in the link's space between the
  run's start and end: arriving early or staying on does not count, camera and
  microphone do not matter, and stretches that overlap (a reconnect, or
  webhooks out of order) count once.
- **Status:** present at 75% of the run or more, partial above none, absent
  at none. Reads give the percentage from `present_seconds` and the tally's
  window.
- **A run that changes after its tally is tallied again:** moved, bound to
  another link, or restored after a cancellation. Seconds are measured
  afresh; a corrected row keeps its status.
- **Only a run cancelled before it ended is voided:** its derived rows are
  deleted, corrected ones kept. A run cancelled after its end took place and
  keeps its attendance; the calendar sync cancels past runs too, when a link
  is revoked, its organiser stops managing the cohort, or an old event is
  deleted.
- **A call row still open since long before the run** (12 hours before its
  end) lost both its leave and its call's end, so it is left out and logged
  rather than counted to now. Somebody staying on after a class still counts.
- **A tally that fails is recorded** in `attendance_tally_failures` and tried
  again after five minutes, doubling each time up to a day; runs that never
  failed go first.
- **No tally deletes a row a correction was written for.**
- **A track or pod that has gone** (detached or deleted after the link was
  revoked) leaves a re-tally expecting whoever the last tally expected.

## Reading and correcting

| Route                                                     | What                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /v1/cohorts/{cohortId}/attendance/classes`           | Tallied runs, newest first, paged, with counts; `from` and `to` filter by start |
| `GET /v1/attendance/classes/{instanceId}`                 | One run with every expected student                                             |
| `GET /v1/cohorts/{cohortId}/attendance/students`          | Per student: classes, present, partial, absent, percentage                      |
| `GET /v1/cohorts/{cohortId}/attendance/students/{userId}` | One student's summary and each class                                            |
| `PUT /v1/attendance/{attendanceId}`                       | Correct a status: `{ status, reason }`                                          |

- **Who:** by the class's audience. Admins read and correct every class.
  A track's classes are for the cohort's live professors on that track, a
  pod's for its mentor. Whole-cohort classes are for admins only. A student
  reads their own attendance, every class, and nobody else's.
- **Percentage** is time in the call as a share of the class, rounded down,
  so it agrees with the status the tally gave (75 and over is present). For a
  class or a summary it is the time across the rows as a share of the time
  they could have had. A corrected status leaves the time as measured.
- **A correction** sets the status and `source = override`, appends to
  `attendance_overrides` with who and why, and writes an
  `attendance_corrected` audit entry, all in one transaction. The row is
  locked while it is corrected, and the tally only overwrites a status while
  `source` is `derived`, so the two cannot interleave. Setting the status it
  already has is a 400.

## Rules the database enforces

| Rule                                            | Constraint                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| A tally's window ends after it starts           | `attendance_tallies_window`                                              |
| One failure record per run                      | `attendance_tally_failures` primary key                                  |
| A run is tallied no earlier than its end        | `attendance_tallies_after_end`                                           |
| One row per student per run                     | `attendance_instance_user_unique`                                        |
| Time in the call is never negative              | `attendance_present_seconds`                                             |
| A correction has a reason                       | `attendance_overrides_reason_not_blank`                                  |
| A link's audience is one it knows               | `room_links_audience_known`                                              |
| A live track or pod link names its track or pod | `room_links_track_matches_audience`, `room_links_group_matches_audience` |
| A link's track or pod belongs to its cohort     | `room_links_cohort_track_fk`, `room_links_mentorship_group_fk`           |

Tested against PGlite with the committed migrations applied, in
`schema.db.spec.ts`, `attendance-tally.service.db.spec.ts` and
`attendance.service.db.spec.ts`; over HTTP in `test/attendance.e2e-spec.ts`.
