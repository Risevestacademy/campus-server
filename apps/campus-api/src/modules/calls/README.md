# Calls

The record of calls held in spaces. Tables only for now: nothing writes to
them yet, and nothing here talks to LiveKit.

| Table                  | A row is                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `sessions`             | One call in a space: which space, the provider's room id, when it opened, and when it closed          |
| `session_participants` | One person's time in a call: when they joined, when they left, and whether they turned their video on |

A session is open while `closed_at` is null, and a participant is still in
the call while `left_at` is null. There is no status column beside them.

## Rules the database enforces

| Rule                                      | Constraint                                                 |
| ----------------------------------------- | ---------------------------------------------------------- |
| At most one open session per space        | `sessions_one_open_per_space`                              |
| Video is off unless somebody turned it on | `session_participants.video_enabled` not null, default off |
| A session is held in a space that exists  | `sessions_space_id_spaces_id_fk`                           |
| A participant is in a session that exists | `session_participants_session_id_sessions_id_fk`           |
| A participant is a person that exists     | `session_participants_user_id_users_id_fk`                 |

They are tested against PGlite, with the committed migrations applied, in
`schema.db.spec.ts`.
