# Space access rules

One question — _may this person enter this space?_ — asked as one pure
function. Facts in, a boolean out: no database, no sockets, and no clock of
its own (the caller passes the moment, so a test can stand at any).

`mayEnter(person, space, at)` lives here because two services have to give the
same answer: **world** asks it on every step into a space, and **campus-api**
whenever a route needs to know the same thing. Two copies of a rule that
decides who gets in would drift, and the drift would open a door rather than
fail a build — which is why `@campus/session` holds the session token once,
and why this holds the door once.

## Two kinds of space

- **Normal** (most of them): anybody in the campus walks in, unless the
  people inside have locked it.
- **Designated**: an admin keeps a list of who may enter, and anybody on it
  always gets in. A designated space cannot be locked.

## The rule, in order

First match stands:

1. **A retired space admits nobody** — admins included.
2. **No kind is not set up yet**, and admits admins only, whatever the access
   setting on the row says.
3. **Admins enter anything** that is set up and standing, past a lock and
   whatever a list says. `admin` and `super_admin` alike, through
   `hasAdminPowers` from `@campus/session`, so "who counts as an admin" has
   one answer across the workspace.
4. **Everybody else must be in this campus**: a live membership in the cohort
   the check names. Ended, expired, absent — or held in some other cohort,
   which is no answer to this question — all say no.
5. **A normal space** admits them unless it is locked. Guests included.
6. **A designated space** admits them if a live entry on its list names them:
   by person, by their track in this cohort, by their role in this cohort, or
   by their system role.
7. Anything else — an access setting this package does not know — says no.

"Live", for a membership, means: not ended, a student explicitly `active`, a
visit not yet run out. That is the question campus-api's `isLiveMembership`
and world's `LIVE_MEMBERSHIP_QUERY` already ask in SQL; this package is where
the words are written down, so neither predicate is the rule's only home.

"Live", for a list entry, means inside its span: from `valid_from` inclusive
to `valid_to` exclusive, with no end meaning none.

## The table

Every standing against the three ways a space can stand to them:

| Standing                                  | Normal | Normal, locked | Designated, empty list |
| ----------------------------------------- | ------ | -------------- | ---------------------- |
| An admin / a super admin                  | ✔      | ✔              | ✔                      |
| A member (student)                        | ✔      | ✘              | ✘                      |
| A professor                               | ✔      | ✘              | ✘                      |
| A mentor                                  | ✔      | ✘              | ✘                      |
| A member on no track                      | ✔      | ✘              | ✘                      |
| A member with a role this does not know   | ✔      | ✘              | ✘                      |
| A guest                                   | ✔      | ✘              | ✘                      |
| A member whose membership has ended       | ✘      | ✘              | ✘                      |
| A guest whose visit has run out           | ✘      | ✘              | ✘                      |
| A member walking a cohort they are not in | ✘      | ✘              | ✘                      |
| Somebody in no cohort                     | ✘      | ✘              | ✘                      |

Beside it: a space with **no kind** admits admins only; a **retired** space
admits nobody, admin included; on a designated space a **live entry** naming
them — the person, their track, their cohort role or their system role —
turns a ✘ into a ✔, and an expired, not-yet-started, wrong-track or
somebody-else's entry does not. A classroom starts with students, professors
and mentors on its list, which leaves its guests out.

## What the caller supplies

- **The space**: `kind`, `access`, `retiredAt` from the `spaces` row; whether
  it is `locked` in this cohort's copy of the campus (world holds locks, not
  the database); and that space's `space_memberships` rows as `grants`. An
  entry on another space is no business of this one's.
- **The person**: `userId`, `systemRole` as text (read from the row, never the
  token), the `cohortId` the check is made under, and their `cohort_members`
  row _in that cohort_. The caller reads the rows; this package decides what
  they mean.

## What was decided, and why

| Open                                                  | Decision                                                                                | Why                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retired against "admins enter anything"               | Retired wins, admins included                                                           | "A retired space admits nobody" is unconditional. An admin manages a retired space through admin routes, not by walking in.                                                                                                                                            |
| Which cohort is "the cohort"                          | The one the caller names: world's socket `cohortId`, the cohort an API route acts under | A space belongs to no cohort — every cohort walks the same map — so the campus context cannot come from the space. World already has it (the socket names its cohort and must hold a live membership in it), and an API route always knows which cohort it asks about. |
| A guest whose visit has run out                       | Not in the campus at all, so refused everywhere, normal spaces included                 | Their membership is not live, so rule 4 catches them first — the same answer world reaches by closing the socket.                                                                                                                                                      |
| A guest at a normal space                             | Admitted, like anybody                                                                  | Decided 2026-10-20: guests are members like any other, except that they may not lock a space — which is for whoever holds locks, not for entry.                                                                                                                        |
| A guest at a designated space                         | Admitted if an entry names them or their role                                           | A list can name a guest by person, or `guest` as a role; a classroom's starting list does neither.                                                                                                                                                                     |
| An entry on a normal space                            | Ignored, and it cannot open a lock                                                      | Nobody is kept out of an unlocked normal space, so there is nothing to widen; a lock is answered by asking the people inside, not by a standing list.                                                                                                                  |
| A lock on a designated space                          | Ignored                                                                                 | Decided 2026-10-20: anybody on a designated space's list always gets in.                                                                                                                                                                                               |
| An entry naming a track, while walking another cohort | Does not count                                                                          | A track belongs to a cohort; the entry speaks for that cohort's campus, not someone else's.                                                                                                                                                                            |
| An entry naming a cohort role                         | Counts in every cohort, read from the membership in the cohort walked                   | A space belongs to no cohort, so "professors" means the professors of whichever campus this is.                                                                                                                                                                        |
| An entry naming the person, in any cohort             | Counts                                                                                  | `space_memberships.user_id` has no cohort on it: the entry was given to them, not to their place.                                                                                                                                                                      |
| A membership row naming a wrong cohort                | Read as no membership                                                                   | A check made for one cohort and answered with another's row is a bug, and the safe answer to a bug is no.                                                                                                                                                              |
| An access setting this package does not know          | Admits admins only (rule 7 falls to no)                                                 | The same reasoning as `hasAdminPowers` on an unknown role: a value the database grows before this knows of it should refuse, not admit.                                                                                                                                |

## Not here yet

- **Locks.** `locked` is always false until world holds them; the rule is
  ready for when it does.
- **Being let in by the people inside.** Asking to enter a locked or
  designated space, and being let in for that visit, is for world to hold
  beside the lock.
- **Mentorship groups on a list.** An entry naming a group comes once the
  groups exist.
- **Reading the rows is the caller's job.** Which query fetches a space's
  list, how often world refreshes it, and where the cohort context comes
  from on an API route all belong to the service making the call.
