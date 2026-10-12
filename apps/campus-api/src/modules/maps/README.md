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
Giving every map its default is the job of whatever writes the map's rows,
and until one exists the tiles outside the drawn spaces have no room at all.

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
| A grant does not end before it starts                      | `space_memberships_valid_window`                        |

They are tested against a real PostgreSQL engine, with the committed
migrations applied, in `schema.db.spec.ts`.

## Nothing is deleted

A map or a space that is no longer published is **retired** (`retired_at`),
not removed: memberships, and later sessions and schedules, still point at
it. A key that comes back is the same row coming back, with the settings it
had, which is why the key stays unique whether or not the row is retired. A
retired town hall, notice board or entry map does not stop another taking
its place.

`space_memberships` works the same way: ending somebody's access sets
`valid_to`, and the row stays as the record that they had it.

## Not here yet

- **Nothing fills these tables.** Rows will come from the published maps.
- **Nothing reads them.** `world` does not consult a space's rules yet, so
  every space is open in practice.
- **Desks.** No desk is drawn on the map yet.
- **Which version of a map is live.** Today `world` loads the latest
  published version. Whether the database should name it is undecided.
