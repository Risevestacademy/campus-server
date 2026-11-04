# Room links

A room link is a short link to a space in one cohort's campus, made for one
event: `{APP_PUBLIC_URL}/join/{code}`. Staff paste it into a calendar event;
the web app's `/join/{code}` page opens it, switches to the cohort and takes
the person to the space.

Routes:

- `POST /v1/cohorts/{cohortId}/spaces/{spaceId}/links` with `{ title }`, and
  optionally `{ startsAt, endsAt }`, makes one.
- `GET /v1/cohorts/{cohortId}/spaces/{spaceId}/links` lists a space's live
  links in the cohort, newest first.
- `GET /v1/room-links/{code}` opens one: its cohort, space, title and window.
- `POST /v1/room-links/{code}/enter` enters through one: see below.
- `PUT /v1/room-links/{code}/window` with `{ startsAt, endsAt }`, or `{}` for
  none, sets when its event runs.
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

## Entering

The `/join/{code}` page calls `POST /v1/room-links/{code}/enter`, then walks
the person to `spaceKey` with world's `goToSpace`.

- **A window is when the event runs.** Staff give one when they make the
  link, or later through `PUT .../window`. A link without one only shows the
  way.
- **The maker's calendar moves it.** Entering first reads the calendar of
  whoever made the link (see the calendar module's README). An event of
  theirs carrying the link that runs now moves the window to its times.
  Otherwise the stored window stands.
- **Entering while the window is open gives a pass.** From ten minutes before
  it starts until it ends (`roomLinkOpen` in `@campus/space-access`), the
  caller gets a row in `room_link_passes`, and `admitted: true`. World lets
  anybody holding a pass into the link's space, in the link's cohort, while
  the window is open, whatever the space's list or a lock says. The rest of
  the door still holds: a removal by staff, a space not yet set up, and a
  place in the cohort that has lapsed all keep them out. A walk about to be
  refused reads the passes once more first, in case one was made a moment
  ago and world has not read it yet. Somebody inside when the window ends stays
  until they leave, as at any door.
- **A pass follows its link.** Moving the window moves every pass with it,
  and revoking the link ends them. Every change tells world to read again.
- **Admins are always admitted**, and need no pass.
- **Changing a window is audited** as `room_link_window_changed`; a move read
  from the calendar is not, since nobody made it.
