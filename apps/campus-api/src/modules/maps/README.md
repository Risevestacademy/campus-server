# Maps and spaces

What the database knows of the campus map: that a map and its spaces exist,
and how each space behaves. Where anything is, it does not know.

## Two homes

| Lives in Sanity, read through `campus-world-map`           | Lives here                                                |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| The map files and every published version of them          | A row per map (`maps`)                                    |
| Walls, the spawn, portals, and where each space is         | A row per space (`spaces`), with its settings             |
| A space's key, and the name and class the designer gave it | Who is on a designated space's list (`space_memberships`) |

The two are joined by key. `maps.key` is the map's ID in Sanity, and
`spaces.key` is the object's name in Tiled, unique on its map. Renaming a
space in Tiled makes it a different space here.

There is no `portals` table and no geometry column. A portal is a region on
one map and a tile on another, which is drawing, so it stays with the map.

## What a space row holds

Everything about how a space behaves, which a drawing cannot say and which
changes without a new map being published:

- `kind`: what sort of room it is. Set by an admin. The class the designer
  gave the object in Tiled is a starting suggestion only, taken when it names
  a known kind. **A space with no kind is not set up yet, and nobody but
  admins may enter it.**
- `access`: `normal` or `designated`. A normal space admits anybody in the
  campus, unless the people inside have locked it; a designated one admits
  whoever its list in `space_memberships` names. Admins enter either.
- `audio_mode`: `proximity` (you hear whoever is near you) or `boundary`
  (everybody in the space hears everybody). Sound never crosses a space's
  edge. There are no broadcast spaces: an admin speaks to the whole campus
  another way.
- `capacity`: how many fit.
- `audible_radius`, `subscribe_radius`, `hysteresis_factor`: the audio
  distances, in tiles. `subscribe_radius` is what the media server
  subscribes people by, so it is what decides the bill.

## The default space

The designer draws the rooms. Everything else on a map (the corridors, the
grounds) is inside no drawn space, and on the first campus map that is
about three quarters of the floor.

So a map has a default space, marked `is_map_default`: it is drawn nowhere,
and is whatever is left. It gives those tiles an audio room, and it is
always normal, because it is the way to everywhere else.

**The database stops a map having two. It does not make a map have one.**
A map row can exist with no default space, and nothing here will object.
Giving every map its default is the job of the [sync](#the-sync), which
writes it with the map's row, under the key `_default` (`DEFAULT_SPACE_KEY`
from `@campus/session`, the same value world answers for a tile in no drawn
space) and the name
"Corridors and grounds". A space drawn with that key is refused.

The default space keeps one key for as long as its map exists. It is only
retired with its map, and comes back with it as the same row, so a retired
one still holds the map's place: a second default under another key is
refused.

## Rules the database enforces

| Rule                                                                    | Constraint                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| A map is known by its key, once                                         | `maps_key_unique`                                       |
| At most one entry map, not counting retired ones                        | `maps_single_entry`                                     |
| A space is known by its key, once per map                               | `spaces_map_key_unique`                                 |
| At most one default space per map, retired or not                       | `spaces_one_default_per_map`                            |
| The default space is normal: open to everybody                          | `spaces_default_is_normal`                              |
| One town hall and one notice board on the campus                        | `spaces_single_town_hall`, `spaces_single_notice_board` |
| A capacity, when there is one, is at least 1                            | `spaces_capacity_positive`                              |
| A list entry names one person, track, cohort role, system role or group | `space_memberships_one_subject`                         |
| An audit entry about a space names one that exists                      | `audit_log_space_id_spaces_id_fk`                       |
| A grant does not end before it starts                                   | `space_memberships_valid_window`                        |

They are tested against a real PostgreSQL engine, with the committed
migrations applied, in `schema.db.spec.ts`.

The database stops a second entry map but does not make there be one: a
campus with none is a state it allows. The [sync](#the-sync) is what makes it
exactly one. It refuses a publish without exactly one entry map, and moves
the flag in the same transaction as everything else, so no sync leaves the
campus without one.

## Nothing is deleted

A map or a space that is no longer published is **retired** (`retired_at`),
not removed: memberships, audit entries, and later sessions and schedules,
still point at it. A key that comes back is the same row coming back, with the settings it
had, which is why the key stays unique whether or not the row is retired. A
retired town hall, notice board or entry map does not stop another taking
its place.

`space_memberships` works the same way: ending somebody's access sets
`valid_to`, and the row stays as the record that they had it. The one
exception is a track taken off its cohort: the ended grants to that track go
with it (see [Granting access](#granting-access)).

## The sync

`POST /v1/maps/sync`, admins only. The database does not hear of a publish
by itself: an admin publishes in the Studio, then calls this, and the rows
are brought level with what is published.

It reads every published map from Sanity (`SANITY_PROJECT_ID`,
`SANITY_DATASET`, no token) and, in one transaction:

| What it finds                                   | What it does                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| A published map with no row                     | Adds the row, named after its key, and its default space                        |
| A drawn space with no row                       | Adds the row, with the kind its Tiled class suggests and that kind's settings   |
| A retired map or space that is published again  | Brings the same row back, with the settings it had                              |
| A row whose map or space is no longer published | Retires it. A retired map takes all its spaces with it                          |
| The entry flag on a different map               | Moves it                                                                        |
| A map or space that is already there            | Nothing. A name, a kind or a setting an admin has changed is never written over |

A Tiled class that names no known kind leaves the space with no kind, so it
is closed to everybody but admins until one is set. The response lists
those under `needsKind`. The same happens to a new space suggested as a
second town hall or notice board: the campus has one of each, so the first
keeps the kind and any other is left for an admin to decide. A space that
already _had_ the kind is different: coming back, it keeps it ahead of any new
space the map suggests for it, whatever order the map lists them in, and if a
live space holds it the sync is refused (below). The settings
each kind starts with are in [`space-defaults.ts`](./space-defaults.ts),
with the list a designated kind starts with: students, professors and
mentors for a classroom or live-coding room (everybody in the cohort but its
guests), and nobody for a mentor pod until an admin adds somebody. The list
is written once, when the sync adds the space, never again. So a space the
sync added with no kind, and an admin later makes a classroom, starts with an
empty list: admins only until an admin puts people on it. Whatever sets a
space's kind should write that kind's starting list too.

`?dryRun=true` answers with what would change and changes nothing.

It is all or nothing. Nothing is written when:

- Sanity cannot be reached, or the project is not configured: `503
SERVICE_UNAVAILABLE`, with `details.reason` of `unreachable` or
  `not_configured`.
- What is published cannot be used: `409 CONFLICT`, with every problem
  listed in `details.problems`. That is no map at all, not exactly one entry
  map, a map that fails `campus-world-map`'s own checks, or a key or name
  too long for its column. Every problem is listed: each map's own, by map
  key, then how the maps that could be read fit together (a link into a map
  that could not be read is left until it can be). It is also a retired
  town hall or notice board published again while another space holds that
  kind: restoring it would mean a second, or taking away the kind it was
  given, so the sync refuses and names both. Unpublish one of them.
- Another sync is running: `409 CONFLICT`. Nothing waits for it; try again
  once it is done.

So a publish that went wrong can never retire the campus.

One sync runs at a time, and it reads Sanity only once it holds the lock, so
a slow sync cannot write a publish older than one already written. That is
tested with two syncs on separate connections to a real PostgreSQL, in
`map-sync.service.pg.spec.ts`. Each map that changed writes a `map_synced`
audit entry, and each one retired a `map_retired`; a sync that changes
nothing writes none.

## Granting access

`POST`, `GET` and `DELETE /v1/spaces/{id}/memberships`, admins only. This is
the admin side of designated spaces: the entries on their lists. The sync
writes a designated kind's starting list when it adds a space; after that,
these routes are the only thing that writes them.

An entry names **exactly one subject**: a person (`userId`); everybody on a
cohort track (`cohortTrackId`, a `cohort_tracks` row, so a track some cohort
actually runs, and only that cohort's people); everybody holding a cohort
role (`cohortRole`), in whichever cohort's campus they walk; everybody
holding a system role (`systemRole`); or everybody in a mentorship group
(`mentorshipGroupId`) — its students and its mentor, and only that cohort's
people, for the same reason as a track: a group belongs to one cohort. An
entry on a normal space is allowed
but does nothing: nobody is kept out of one to be let in. It starts the moment it is
given and may carry an end date (`validTo`, in the future: a bare date,
read as midnight UTC, or a timestamp with its zone); without one it has no
end until an admin ends it. Ending sets `valid_to` and keeps the row,
as [above](#nothing-is-deleted). Each change writes an audit entry naming
the admin, in the same transaction as the row, and is the first thing to
fill `audit_log.space_id`.

Every grant to a subject on a space must not overlap another. The database
cannot hold that rule itself: "still live" is a question about now, and a
partial unique index may only name immutable conditions, so `now()` is
refused in one. The service holds it instead — the space's row is locked
before anything is judged, so two grants for one space take turns and the
second sees the first. That cannot be shown on PGlite, which never overlaps
two transactions, so it is tested on a server with more than one connection
(`space-memberships.pg.spec.ts`).

Refused, each with the status that says which: no such space or no such
subject (404), a retired space or a subject that already holds a live grant
(409), more than one subject or none, an id that is not a UUID, a role there
is not, or an end date that has passed or is not a date or zoned timestamp
(400).

**A track detached from its cohort.** A track grant points at the
`cohort_tracks` row, so detaching the track
(`DELETE /v1/cohorts/{id}/tracks/{trackId}`) has to decide what happens to
its grants. A grant that has not ended refuses the detach (409, naming the
spaces) — end it first, so access is never taken away without anyone ending
it. Ended grants go with the track: kept for good, they would block the
detach, and so the cohort's deletion, forever. Their record is the audit
log — each grant's `space_membership_granted` and `space_membership_ended`
entries — and the `cohort_track_detached` entry names the grants it cleared.
The detach locks the link before it looks for grants, and a grant to a
track holds the link with `key share`, so the two never cross: tested in
`space-memberships.pg.spec.ts`.

**A mentorship group deleted.** A group entry points at the `mentorship_groups`
row, so deleting the group (`DELETE /v1/cohorts/{id}/mentorship-groups/{groupId}`)
refuses while a live entry names it (409, naming the spaces): end it first, so
access is never taken away without anyone ending it. Ended entries go with the
group, as a detached track's do, and the audit log is their record. The delete
locks the group before it looks for entries, and a grant to a group holds it
with `key share`, so the two never cross.

## Not here yet

- **Locks, and asking to enter.** Who may enter is answered by
  [`@campus/space-access`](../../../../../packages/space-access/README.md)'s
  `mayEnter`, which world asks on every step into a space, reading these
  rows. A normal space cannot be locked yet, and nobody can ask into a
  designated one. Both are live state for world to hold, not rows here.
- **Mentorship groups on a list.** An entry naming a group comes once the
  groups exist.
- **Desks.** No desk is drawn on the map yet.
- **Which version of a map is live.** Today `world` loads the latest
  published version. Whether the database should name it is undecided, so
  the sync reports the version it read and stores none.
- **Setting a space up.** No route changes a space's kind or settings yet.
- **The sync does not reach `world`.** It loads its map at startup, so a new
  publish is live there after a restart, whether or not this has run.
