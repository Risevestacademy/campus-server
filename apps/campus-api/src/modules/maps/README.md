# Maps and spaces

What the database knows of the campus map: that a map and its spaces exist,
and how each space behaves. Where anything is, it does not know.

## Two homes

| Lives in Sanity, read through `campus-world-map`           | Lives here                                         |
| ---------------------------------------------------------- | -------------------------------------------------- |
| The map files and every published version of them          | A row per map (`maps`)                             |
| Walls, the spawn, portals, and where each space is         | A row per space (`spaces`), with its settings      |
| A space's key, and the name and class the designer gave it | Who has been granted a space (`space_memberships`) |

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
- `access`, `audio_mode`, `publish_policy`, `outsider_visibility`,
  `capacity`: who may enter, how people hear one another, who may speak, what
  somebody outside is shown, and how many fit.
- `audible_radius`, `subscribe_radius`, `hysteresis_factor`: the audio
  distances, in tiles. `subscribe_radius` is what the media server
  subscribes people by, so it is what decides the bill.

## The default space

The designer draws the rooms. Everything else on a map (the corridors, the
grounds) is inside no drawn space, and on the first campus map that is
about three quarters of the floor.

So a map has a default space, marked `is_map_default`: it is drawn nowhere,
and is whatever is left. It gives those tiles an audio room, and it is
always open, because it is the way to everywhere else.

**The database stops a map having two. It does not make a map have one.**
A map row can exist with no default space, and nothing here will object.
Giving every map its default is the job of the [sync](#the-sync), which
writes it with the map's row, under the key `_default` and the name
"Corridors and grounds". A space drawn with that key is refused.

The default space keeps one key for as long as its map exists. It is only
retired with its map, and comes back with it as the same row, so a retired
one still holds the map's place: a second default under another key is
refused.

## Rules the database enforces

| Rule                                                       | Constraint                                              |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| A map is known by its key, once                            | `maps_key_unique`                                       |
| One entry map, not counting retired ones                   | `maps_single_entry`                                     |
| A space is known by its key, once per map                  | `spaces_map_key_unique`                                 |
| At most one default space per map, retired or not          | `spaces_one_default_per_map`                            |
| The default space is open to everybody                     | `spaces_default_is_open`                                |
| One town hall and one notice board on the campus           | `spaces_single_town_hall`, `spaces_single_notice_board` |
| A broadcast is not one if everybody may speak              | `spaces_broadcast_restricts_publish`                    |
| A capacity, when there is one, is at least 1               | `spaces_capacity_positive`                              |
| A grant is to one person or one track, not both or neither | `space_memberships_one_subject`                         |
| An audit entry about a space names one that exists         | `audit_log_space_id_spaces_id_fk`                       |
| A grant does not end before it starts                      | `space_memberships_valid_window`                        |

They are tested against a real PostgreSQL engine, with the committed
migrations applied, in `schema.db.spec.ts`.

## Nothing is deleted

A map or a space that is no longer published is **retired** (`retired_at`),
not removed: memberships, audit entries, and later sessions and schedules,
still point at it. A key that comes back is the same row coming back, with the settings it
had, which is why the key stays unique whether or not the row is retired. A
retired town hall, notice board or entry map does not stop another taking
its place.

`space_memberships` works the same way: ending somebody's access sets
`valid_to`, and the row stays as the record that they had it.

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
those under `needsKind`. The same happens to a second town hall or notice
board: the campus has one of each, so the first keeps the kind and any
other is left for an admin to decide. The settings each kind starts with
are in [`space-defaults.ts`](./space-defaults.ts).

`?dryRun=true` answers with what would change and changes nothing.

It is all or nothing. Nothing is written when:

- Sanity cannot be reached, or the project is not configured: `503
SERVICE_UNAVAILABLE`, with `details.reason` of `unreachable` or
  `not_configured`.
- What is published cannot be used: `409 CONFLICT`, with every problem
  listed in `details.problems`. That is no map at all, not exactly one entry
  map, a map that fails `campus-world-map`'s own checks, or a key or name
  too long for its column.

So a publish that went wrong can never retire the campus.

Two syncs at once take turns. Each map that changed writes a `map_synced`
audit entry, and each one retired a `map_retired`; a sync that changes
nothing writes none.

## Not here yet

- **Nothing reads them.** `world` does not consult a space's rules yet, so
  every space is open in practice.
- **Desks.** No desk is drawn on the map yet.
- **Which version of a map is live.** Today `world` loads the latest
  published version. Whether the database should name it is undecided, so
  the sync reports the version it read and stores none.
- **Setting a space up.** No route changes a space's kind or settings yet.
- **The sync does not reach `world`.** It loads its map at startup, so a new
  publish is live there after a restart, whether or not this has run.
