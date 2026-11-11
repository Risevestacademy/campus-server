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
- **A run cancelled after its tally no longer counts:** its derived rows are
  deleted, corrected ones kept.
- **A track or pod that has gone** (detached or deleted after the link was
  revoked) leaves a re-tally expecting whoever the last tally expected.

## Rules the database enforces

| Rule                                            | Constraint                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| A tally's window ends after it starts           | `attendance_tallies_window`                                              |
| A run is tallied no earlier than its end        | `attendance_tallies_after_end`                                           |
| One row per student per run                     | `attendance_instance_user_unique`                                        |
| Time in the call is never negative              | `attendance_present_seconds`                                             |
| A correction has a reason                       | `attendance_overrides_reason_not_blank`                                  |
| A link's audience is one it knows               | `room_links_audience_known`                                              |
| A live track or pod link names its track or pod | `room_links_track_matches_audience`, `room_links_group_matches_audience` |
| A link's track or pod belongs to its cohort     | `room_links_cohort_track_fk`, `room_links_mentorship_group_fk`           |

Tested against PGlite with the committed migrations applied, in
`schema.db.spec.ts` and `attendance-tally.service.db.spec.ts`.
