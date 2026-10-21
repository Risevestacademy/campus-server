# Calls

The record of calls held in spaces, written from LiveKit's webhooks
(`POST /v1/calls/webhook`). world hands people the calls; this records them.

| Table                  | A row is                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `sessions`             | One call in a cohort's space: which cohort and space, the provider's room id, when it opened and closed |
| `session_participants` | One person's time in a call: when they joined, when they left, and whether they turned their video on   |

A session is open while `closed_at` is null, and a participant is still in
the call while `left_at` is null. There is no status column beside them.

Every cohort walks the same map, but each is its own campus, so a call
belongs to a cohort as well as a space. Two cohorts can each have a call in
the library at once.

## Rules the database enforces

| Rule                                             | Constraint                                                 |
| ------------------------------------------------ | ---------------------------------------------------------- |
| At most one open session per space in a cohort   | `sessions_one_open_per_cohort_space`                       |
| A person is in a call at most once at a time     | `session_participants_one_open_per_person`                 |
| A session closes no earlier than it opened       | `sessions_closed_after_opened`                             |
| A participant leaves no earlier than they joined | `session_participants_left_after_joined`                   |
| Video is off unless somebody turned it on        | `session_participants.video_enabled` not null, default off |
| A session is held in a cohort that exists        | `sessions_cohort_id_cohorts_id_fk`                         |
| A session is held in a space that exists         | `sessions_space_id_spaces_id_fk`                           |
| A participant is in a session that exists        | `session_participants_session_id_sessions_id_fk`           |
| A participant is a person that exists            | `session_participants_user_id_users_id_fk`                 |

They are tested against PGlite, with the committed migrations applied, in
`schema.db.spec.ts`.

## Recording

LiveKit posts an event to `POST /v1/calls/webhook` for everything that
happens in a room, signed with the key pair in `LIVEKIT_WEBHOOK_API_KEY` and
`LIVEKIT_WEBHOOK_API_SECRET`; the signature is checked against the raw body,
and anything unsigned or signed otherwise is a 401. A space's room is named
`space:<cohort id>:<space id>`, which is how an event finds its cohort and
space; any other room, such as a connection check, is acknowledged and
ignored. A session is one run of that room, keyed by LiveKit's id for the
run (`provider_room_id`, unique): a room that empties and fills again is a
new session.

| Event                | What it writes                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `room_started`       | Opens the cohort's session in the space, if none is open             |
| `participant_joined` | A participant row, opening the session first if its start was missed |
| `participant_left`   | `left_at` on the row with that identity                              |
| `track_published`    | `video_enabled` when the track is a camera                           |
| `room_finished`      | `closed_at` on the session, and `left_at` on everybody still in it   |

LiveKit retries what it could not deliver and does not promise order, so
each event checks what is recorded first. A second join, leave or room event
is a no-op; a join retried after its leave reopens nothing; a join that
arrives after its run finished is dropped. Each run's events are applied one
at a time, under a lock on its session. A run that starts while an earlier
one is still open closes the earlier one, and news of the earlier run that
arrives after that is dropped. A participant's
identity is their user id, a colon and a suffix world makes fresh for each
entry (`provider_identity`). Somebody who walks out and straight back in can
have a new identity join before LiveKit says the old one left; the old row
is closed then, so a person has one open row per call.
