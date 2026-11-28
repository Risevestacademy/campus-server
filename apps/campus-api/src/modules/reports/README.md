# Reports

A cohort's membership and attendance for admins, whole rather than paged,
to read as JSON or download as CSV. No tables of its own: it reads the
roster and the attendance tallies.

| Route                                           | What                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| `GET /v1/cohorts/{cohortId}/reports/membership` | Every membership: role, track, status, joined, ended, why |
| `GET /v1/cohorts/{cohortId}/reports/attendance` | Per student over a range of classes: counts, time, %      |

- **Who:** admins only (`SessionGuard`, `AdminGuard`). Professors and mentors
  read their own classes through the attendance routes.
- **Filters:** `state` (`all` by default, then `live` or `ended`, the
  roster's rule), `trackId` (a catalogue track, as on the roster), `role` on
  membership. Attendance takes `from` and `to`, class starts in
  [`from`, `to`), as `GET /attendance/classes` does.
- **Attendance rows** are every student the cohort has had, so a student
  expected at nothing in the range is a row of zeros with a null percentage,
  plus anybody since moved out of the student role who has rows. Track and
  state are the membership's now, not at each class. The percentage is the
  one the attendance reads give: time in the call over the length of the
  classes, rounded down.
- **`format=csv`** sends `text/csv` as an attachment, named
  `{code}-{report}-{date}.csv`: UTF-8 with a byte-order mark for Excel,
  snake_case headers, timestamps in ISO 8601. A text cell that starts with
  `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a
  spreadsheet shows a typed name instead of running it (`shared/csv`).
- **Each download writes `report_exported`** to the audit log: which report,
  its filters and how many rows, never the rows. A JSON read writes nothing,
  as reading the roster writes nothing.
- **Both formats send `Cache-Control: no-store`.**

Tested against PGlite in `reports.service.db.spec.ts`; over HTTP in
`test/reports.e2e-spec.ts`.
