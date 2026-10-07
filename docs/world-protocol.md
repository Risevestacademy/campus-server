# World protocol

How a client talks to `world`, the realtime service: connecting, moving,
drawing everybody else, and what to do when the socket closes.

The message shapes are not in this document. They live in
[`apps/world/protocol.schema.json`](../apps/world/protocol.schema.json),
generated from the server's code, with a description on every message and
field. Every world instance also serves the one it is running, at
`GET /schema.json`, with no sign-in needed. Generate your types from it
rather than writing them by hand, against whichever environment you build
for:

```sh
curl -s https://ws.dev.campusbyrise.com/schema.json \
  | npx json-schema-to-typescript -o world-protocol.d.ts
```

Each environment serves the protocol of the code deployed there, so one that
is behind another describes the older protocol.

The same instance documents the protocol the way campus-api documents its
routes: a page at `GET /docs`, and behind it the document at `GET /docs-json`.
The document is [AsyncAPI](https://www.asyncapi.com). It holds the same
message shapes and adds what a plain schema cannot say: the socket's address,
how to get in, and which messages a client sends and which it is sent. Read
the page to browse the protocol; give `/docs-json` to anything that reads
AsyncAPI, such as Postman, which can import it and build a WebSocket
collection from it. For generating types, `/schema.json` is the simpler
input.

That gives `ClientMessage`, `ServerMessage`, one type per message
(`MoveMessage`, `MovedMessage`, `MoveResultMessage`, …), and `Player`,
`Direction` and `MoveOutcome`. This document covers what the schema cannot:
the order things happen in, and what the client is expected to do about them.

## Connecting

Open a WebSocket to `/socket?cohortId=<uuid>` on the world service. Every
frame, both ways, is one JSON object with a `type`.

- **Name the cohort you are entering.** `cohortId` is required and there is no
  default: somebody may belong to several, and world will not pick for them.
  Take it from the one the person chose in the picker — `/v1/auth/me` lists
  every cohort they may enter. Leaving it off is refused with `no_cohort`, and
  a cohort they hold no live membership in with `not_a_member`. Admins are the
  exception: their role alone admits them to any cohort, as it does at
  campus-api's sign-in gate.
- **Authentication is the session cookie.** The browser sends
  `campus_session` on the upgrade by itself; the page does nothing. Only a
  `full_access` session gets in — somebody still in onboarding is refused.
- **The page's origin must be in world's `CORS_ORIGINS`.** A WebSocket is not
  covered by CORS, so world checks `Origin` itself and refuses anything not on
  its list.
- **Not a browser?** Send `Authorization: Bearer <token>` and no cookie.

> **World on its own hostname.** Browsers cannot put an `Authorization`
> header on a WebSocket, so the cookie is the only way in, and by default it
> only goes back to the host that set it. Locally that is fine: cookies ignore
> ports, and both services are `localhost`. Deployed, set campus-api's
> `AUTH_COOKIE_DOMAIN` to the parent domain (`campus.example` for a web app on
> `campus.example` and world on `world.campus.example`); the access cookie is
> then sent to world too. The refresh cookie never is.

### What arrives first

```mermaid
sequenceDiagram
    participant C as Client
    participant W as world
    C->>W: upgrade /socket?cohortId=… (cookie)
    alt let in
        W-->>C: welcome
        W-->>C: snapshot
        Note over C,W: then moves, joins and leaves, for as long as the socket lives
    else refused
        W-->>C: error UNAUTHORIZED (message = reason)
        W--xC: close 1008
    end
```

- **`welcome`** carries your `userId` and the timings to play by:
  `stepMs` (walking speed), `tickMs` (how often others' moves arrive) and
  `heartbeatSeconds`.
- **`snapshot`** carries the map size and every player on it, you included.
  Draw from it; everything after is a change to it.

You can send as soon as the socket opens. Frames sent while the server is
still checking the session are held, not lost, and answered in order.

## The map

Positions are **tiles**, never pixels: `x` is the column from 0 at the left,
`y` the row from 0 at the top, so `up` is `y - 1`. The tile's pixel size is
entirely the client's — multiply by it to draw. The server never sees it.

For now the map is a placeholder rectangle of `snapshot.map.width` ×
`height`, and its edge is the only thing that blocks. Real maps, with walls,
spaces and portals, replace it later.

Two people can stand on the same tile. Nobody blocks anybody.

## Moving yourself

The client says which way, never where to. The server decides every position.

1. **Move at once, then tell the server.** On a key press, draw the step
   straight away and send `{ "type": "move", "direction": "right", "seq": 12 }`.
   `seq` is your own counter; increase it by one per move.
2. **Pace to `stepMs`.** Animate each step over `welcome.stepMs`, and while a
   key is held send the next move when the previous animation ends. Faster
   than that and the server answers `too_fast`. It allows a short burst — a
   few steps delayed by the network and delivered together — but not a
   sustained run.
3. **Every admitted move is answered with a `moveResult`**, in the order sent,
   carrying your `seq` and where the server has you:

   | `outcome`  | Meaning                                                 | What to draw                  |
   | ---------- | ------------------------------------------------------- | ----------------------------- |
   | `moved`    | One tile, as you predicted                              | Nothing changes               |
   | `blocked`  | Not walkable; you turn to face it without moving        | Snap back, facing the new way |
   | `too_fast` | Over walking speed; nothing happened, not even the turn | Snap back                     |

4. **Correct against the server, then replay what it has not answered yet.**
   By the time a `moveResult` arrives you may have predicted further steps.
   Throwing those away would jerk the avatar backwards; keeping the prediction
   and ignoring the answer would let the two drift apart. So:

   ```ts
   // `pending`: moves sent and not yet answered, oldest first.
   function onMoveResult(result: MoveResultMessage) {
     pending = pending.filter((move) => move.seq > result.seq);
     me = result.player;
     for (const move of pending) {
       me = predictStep(me, move.direction); // your own step, edge check included
     }
   }
   ```

   When every prediction was right — nearly always — this changes nothing on
   screen.

## Everybody else

| Message  | When                                              | What to do              |
| -------- | ------------------------------------------------- | ----------------------- |
| `joined` | Somebody arrived                                  | Add their avatar        |
| `left`   | Somebody's socket closed, or they left the cohort | Remove their avatar     |
| `moved`  | Once per tick, if anybody moved or turned         | Move each listed player |

About `moved`:

- **One entry per person, as they stand now.** Two steps inside one tick
  arrive as the second, so an entry can be **more than one tile** from where
  you last drew them. Walk the gap one tile at a time rather than sliding
  diagonally — a diagonal slide cuts corners that will be walls once real
  maps exist.
- **You are never in your own `moved` frame** — your `moveResult` already says
  where you ended up.

## One place at a time

**An account is inside the campus world in one place: one cohort, one device,
one tab.** The newest connection wins. Opening a second one does not give the
person two views of their avatar; it takes the first one's place.

Other pages are unaffected. The cohort picker, a profile screen and an invite
screen hold no socket, so they keep working in as many tabs as you like.

When a connection is displaced, world sends it `{ "type": "replaced" }` and
closes it with **4000 `entered_elsewhere`**.

- **Entering the same cohort again**, from another tab or device, leaves the
  avatar exactly where it stood. Nobody is told anybody left or arrived.
- **Entering a different cohort** takes the avatar out of the old one — others
  there see `left` — and puts it into the new one, at the same position for
  now.

> **Do not reconnect on `entered_elsewhere`.** This is the one close the
> client must not retry. Two tabs that both reconnected would replace each
> other for as long as both stayed open, and neither would be usable. Show
> **"You opened the campus somewhere else"** with an **"Enter here"** button,
> and reconnect only when the person presses it.

## Limits

- **Messages:** about `WORLD_MAX_MESSAGES_PER_SECOND` (20 by default) per
  socket, with a second's worth allowed at once. Walking at full speed while
  pinging uses about half. The first frame past the budget closes the socket
  with `rate_limited` before parsing. Reconnect and rebuild state from the
  fresh snapshot.
- **Frame size:** 16 KB by default. Larger closes the socket with 1009.
- **Reading:** a client that stops reading what it is sent — a frozen tab, a
  debugger paused on a breakpoint — is disconnected once about 1 MB is waiting
  for it, rather than skipped: skipped frames would leave it believing people
  stand where they no longer do. It sees a 1006 and reconnects to a fresh
  snapshot.

## Staying connected

The server pings every `heartbeatSeconds` and drops a socket that has not
answered by the next ping. Browsers answer these pings themselves; there is
nothing to write. The `ping` message exists for clients that want to measure
round-trip time, and gets a `pong`.

**Keep the sign-in refreshed.** The socket does not end when the access token
it opened with expires; it stays while the sign-in behind it is live — not
signed out, and refreshed through `POST /v1/auth/refresh` within the last 20
minutes. So refresh ahead of time — a minute before the `expiresAt` that
each refresh (and `GET /v1/auth/me`) returns — even while the user is only
standing in the world and making no other calls.
Refreshing only after an API call fails would let the socket close with
`session_ended` during a quiet stretch. See
[auth-flow.md](./auth-flow.md#how-world-follows-a-sign-in).

## Errors and closing

An `error` with code `BAD_MESSAGE` means the frame was not valid JSON or not a
message the server knows. The socket stays open. Seeing one means a client
bug, so log it.

When the socket closes:

| Code | Reason                                | Meaning                                                                                    | What to do                                                             |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1008 | `no_token`                            | No session was sent                                                                        | Send them to sign in                                                   |
| 1008 | `token_not_usable`, `session_expired` | The session sent is not usable: expired, or signed before a change to what a token carries | Try a refresh; if that fails, send them to sign in                     |
| 1008 | `session_ended`                       | Signed out, or the sign-in stopped being refreshed                                         | Try a refresh; if that fails, send them to sign in                     |
| 1008 | `session_revoked`                     | The account's sessions were ended on purpose                                               | Send them to sign in; a refresh will not work                          |
| 1008 | `wrong_scope`                         | Still in onboarding                                                                        | Send them to onboarding                                                |
| 1008 | `account_suspended`, `account_gone`   | Not welcome any more                                                                       | Sign them out; do not reconnect                                        |
| 1008 | `origin_not_allowed`                  | This page's origin is not on world's list                                                  | Configuration — do not retry                                           |
| 1008 | `no_cohort`                           | The upgrade named no `cohortId`                                                            | Client bug; do not retry without one                                   |
| 1008 | `not_a_member`                        | No live membership in the cohort named; admins excepted                                    | Back to the cohort picker; do not retry                                |
| 1008 | `rate_limited`                        | Sustained sending over the message budget                                                  | Client bug; reconnect with backoff                                     |
| 4000 | `entered_elsewhere`                   | This account opened the campus somewhere else                                              | **Do not reconnect** — see [One place at a time](#one-place-at-a-time) |
| 1001 | `server shutting down`                | A deploy or restart                                                                        | Reconnect                                                              |
| 1009 | —                                     | A frame over the size limit (16 KB by default)                                             | Client bug; reconnect                                                  |
| 1011 | `internal_error`                      | The server could not check the session                                                     | Reconnect with backoff                                                 |
| 1006 | —                                     | Connection lost, a missed heartbeat, or not reading fast enough                            | Reconnect with backoff                                                 |

When the connection is refused at the start, an `error` frame with the same
reason as its `message` arrives just before the close. A socket closed later
— `session_ended`, `session_expired`, `session_revoked`, or a suspension
that reaches an open socket — gets the close alone, so read the reason from the close event, not from an `error`.

**A reconnect resumes where you stood** if it comes within
`WORLD_RECONNECT_GRACE_SECONDS` (30 by default) of your socket closing.
That covers a network blip, the server's own cut-offs — `rate_limited`, a
missed heartbeat, not reading fast enough — and `session_ended`,
`session_expired` or `session_revoked`: signing straight back in resumes too, since a sign-in
ending is routine rather than access being taken away. Past the grace, or
after a server restart, you start where you last stood on an earlier visit —
world keeps that between visits — or at the spawn if nothing is kept, the
tile is no longer walkable, or it was more than 90 days ago. So never assume
an arrival is at the spawn: read your position from the `snapshot`.

A suspension or a removed account forgets the position as soon as world
notices: at its next check of open sockets, or when a reconnect is refused
for it. If a suspension is lifted before either happens, the person was never
refused and resumes as normal.

Either way, take your position from the new `snapshot`, never from what you
drew before the drop, and throw away any moves still pending: they were
answered, or not, on the old socket.

Others see you leave straight away and arrive again when you return. There
is no frozen stand-in while you are gone — somebody who closed the tab should
not linger on everybody's screen for the length of the grace.

## Changing the protocol

For whoever edits the server:

1. Change the schemas in `apps/world/src/socket/protocol.ts`, with a
   description on anything new.
2. Run `pnpm --filter world protocol:schema` and commit the regenerated
   `protocol.schema.json`. CI fails if you forget.
3. Update this document if what a client should _do_ changed.
4. Tell the frontend: they regenerate their types once it is deployed, from
   that environment's `/schema.json`.
