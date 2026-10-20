# Space access rules

One question — _may this person enter this space?_ — asked as one pure
function. Facts in, a boolean out: no database, no sockets, and no clock of
its own (the caller passes the moment, so a test can stand at any).

`mayEnter(person, space, at)` lives here because two services have to give the
same answer: **world** will ask it on every step into a space, and
**campus-api** whenever a route needs to know the same thing. Two copies of a
rule that decides who gets in would drift, and the drift would open a door
rather than fail a build — which is why `@campus/session` holds the session
token once, and why this holds the door once.

## The rule, in order

First match stands:

1. **A retired space admits nobody** — admins included.
2. **No kind is not set up yet**, and admits admins only, whatever the access
   setting on the row says.
3. **Admins enter anything** that is set up and standing. `admin` and
   `super_admin` alike, through `hasAdminPowers` from `@campus/session`, so
   "who counts as an admin" has one answer across the workspace.
4. **Everybody else must be in this campus**: a live membership in the cohort
   the check names. Ended, expired, absent — or held in some other cohort,
   which is no answer to this question — all say no.
5. **A guest enters open spaces, and request spaces they hold a live grant
   on.** A guest may ask into a classroom; `cohort` and `invite` stay shut to
   them, grant or not.
6. **The access setting**: `open` and `cohort` say yes. For everybody but a
   guest, `invite` and `request` say yes only if a live grant on this space names this person, or their
   track in this cohort. Anything else says no.

"Live", for a membership, means: not ended, a student explicitly `active`, a
visit not yet run out. That is the question campus-api's `isLiveMembership`
and world's `LIVE_MEMBERSHIP_QUERY` already ask in SQL; this package is where
the words are written down, so neither predicate is the rule's only home.

"Live", for a grant, means inside its span: from `valid_from` inclusive to
`valid_to` exclusive, with no end meaning none.

## The table

Every access setting against every standing, on a space with no grant on it:

| Standing                                  | `open` | `cohort` | `invite` | `request` |
| ----------------------------------------- | ------ | -------- | -------- | --------- |
| An admin / a super admin                  | ✔      | ✔        | ✔        | ✔         |
| A member (student)                        | ✔      | ✔        | ✘        | ✘         |
| A professor                               | ✔      | ✔        | ✘        | ✘         |
| A mentor                                  | ✔      | ✔        | ✘        | ✘         |
| A member on no track                      | ✔      | ✔        | ✘        | ✘         |
| A member with a role this does not know   | ✔      | ✔        | ✘        | ✘         |
| A guest                                   | ✔      | ✘        | ✘        | ✘         |
| A member whose membership has ended       | ✘      | ✘        | ✘        | ✘         |
| A guest whose visit has run out           | ✘      | ✘        | ✘        | ✘         |
| A member walking a cohort they are not in | ✘      | ✘        | ✘        | ✘         |
| Somebody in no cohort                     | ✘      | ✘        | ✘        | ✘         |

Beside it: a space with **no kind** admits admins only (guests and members
refused, whatever `access` says); a **retired** space admits nobody, admin
included; on `invite` and `request` a **live grant** — to them, or to their
track — turns a ✘ into a ✔ (for a guest, on `request` only), and an expired, not-yet-started, wrong-track or
somebody-else's grant does not.

## What the caller supplies

- **The space**: `kind`, `access`, `retiredAt` from the `spaces` row, and that
  space's `space_memberships` rows as `grants`. A grant on another space is no
  business of this one's.
- **The person**: `userId`, `systemRole` as text (read from the row, never the
  token), the `cohortId` the check is made under, and their `cohort_members`
  row _in that cohort_. The caller reads the rows; this package decides what
  they mean.

## What was decided, and why

The spec left these open; here is where they landed.

| Open                                                             | Decision                                                                                | Why                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retired against "admins enter anything"                          | Retired wins, admins included                                                           | "A retired space admits nobody" is unconditional. An admin manages a retired space through admin routes, not by walking in.                                                                                                                                            |
| Which cohort is "the cohort"                                     | The one the caller names: world's socket `cohortId`, the cohort an API route acts under | A space belongs to no cohort — every cohort walks the same map — so the campus context cannot come from the space. World already has it (the socket names its cohort and must hold a live membership in it), and an API route always knows which cohort it asks about. |
| A guest whose visit has run out                                  | Not in the campus at all, so refused everywhere, open included                          | Their membership is not live, so rule 4 catches them before the guest rule — the same answer world reaches by closing the socket.                                                                                                                                      |
| A membership that has ended, on `open`                           | Refused                                                                                 | "Open admits anybody _in the campus_." The roster is the campus.                                                                                                                                                                                                       |
| `invite` vs `request` at the door                                | Identical, except for a guest                                                           | The difference is how access is _obtained_, not whether a grant opens the door. Somebody standing at the door can only see the grant.                                                                                                                                  |
| A guest with a grant                                             | Counts on `request`, nowhere else                                                       | A guest may ask into a classroom, and an approved request is a grant. `cohort` and `invite` stay shut to them, as the spec's "a guest enters open spaces" had it.                                                                                                      |
| A grant on an `open` or `cohort` space                           | Ignored                                                                                 | Nobody is excluded by those settings, so there is nothing for a grant to widen. A grant never admits a guest to a `cohort` space.                                                                                                                                      |
| A grant to a track, while walking another cohort                 | Does not count                                                                          | A track belongs to a cohort; the grant speaks for that cohort's campus, not someone else's.                                                                                                                                                                            |
| A grant to the person, in any cohort                             | Counts                                                                                  | `space_memberships.user_id` has no cohort on it: the grant was given to them, not to their place.                                                                                                                                                                      |
| A membership row naming a wrong cohort                           | Read as no membership                                                                   | A check made for one cohort and answered with another's row is a bug, and the safe answer to a bug is no.                                                                                                                                                              |
| An access value this package does not know                       | Admits admins only (rule 6 falls to no)                                                 | The same reasoning as `hasAdminPowers` on an unknown role: a value the database grows before this knows of it should refuse, not admit.                                                                                                                                |
| An unknown cohort role (not student, professor, mentor or guest) | Read as an ordinary member                                                              | Professor and mentor need no special case, and neither does the next staff role added; only `guest` is a gate. Guessing "guest" would lock out whoever the database grows next.                                                                                        |

## Not here yet

- **Nothing calls it.** world does not gate steps on it and no API route asks
  yet, so every space is open in practice. That wiring is the work that comes
  after this package.
- **Reading the rows is the caller's job.** Which query fetches a space's
  grants, how often world refreshes them, and where the cohort context comes
  from on an API route all belong to the service making the call.
