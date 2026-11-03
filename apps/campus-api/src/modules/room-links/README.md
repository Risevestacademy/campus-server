# Room links

A room link is a short link to a space in one cohort's campus, made for one
event: `{APP_PUBLIC_URL}/join/{code}`. Staff paste it into a calendar event;
the web app's `/join/{code}` page opens it, switches to the cohort and takes
the person to the space.

Routes:

- `POST /v1/cohorts/{cohortId}/spaces/{spaceId}/links` with `{ title }` makes
  one.
- `GET /v1/cohorts/{cohortId}/spaces/{spaceId}/links` lists a space's live
  links in the cohort, newest first.
- `GET /v1/room-links/{code}` opens one: its cohort, space and title.
- `DELETE /v1/room-links/{code}` revokes one.

## Decisions

- **One link per event, not per room.** A space may have any number of live
  links in a cohort at once, each with its own code and title. The title is
  given by whoever makes the link, since the calendar event may not exist yet.
- **The code is a pointer, not a key.** Ten random letters and digits. Opening
  one checks the caller has a live place in its cohort, or is an admin, so a
  code found by somebody else lets them in nowhere. Getting into the space is
  still world's to decide, as for anybody walking up to it.
- **Only spaces on the entry map.** World plays the entry map alone, so a
  link to a space on any other map is refused, and one made before the entry
  map moved stops opening.
- **Not the corridors.** No meeting happens in a map's default space, so it
  takes no links.
- **A link nobody may open is a 404.** Revoked, its space retired or never set
  up, or a cohort the caller holds no place in: the answer is the same, so a
  code says nothing to somebody it is not for.
- **Who manages links.** Admins, and the cohort's live professors and mentors,
  make, list and revoke them. Revoking sets `revoked_at` and keeps the row;
  revoking twice is fine.
- **Making and revoking are audited.** `room_link_created` and
  `room_link_revoked`, with `space_id` set; opening a link writes nothing.
- **Links do not expire.** They last until revoked or until the space leaves
  the map.
