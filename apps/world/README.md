# world

The realtime service: one WebSocket per account, carrying who is on the map
and where they stand. Fastify 5 with `@fastify/websocket`, config validated
with zod at boot.

It trusts nothing from the client but a direction. The session comes from the
cookie campus-api signs, the account is re-checked against Postgres, and the
server decides every position.

## What it does today

- **Authenticates the upgrade:** the origin allowlist, then the session
  token (full-access sessions only), then the account, which must exist and
  not be suspended, then the sign-in it came from, which must still be live,
  and last the cohort the socket names (`/socket?cohortId=…`), which the
  account must hold a live membership in — the same rule campus-api applies
  at sign-in, admins included: their role alone admits them anywhere.
- **One place at a time:** an account is in the world in one cohort, on one
  device, in one tab. A new connection displaces the old one, which is sent
  `{ "type": "replaced" }` and closed with 4000 `entered_elsewhere`. Entering
  the same cohort leaves the avatar untouched; entering a different one moves
  it across. See [the protocol doc](../../docs/world-protocol.md#one-place-at-a-time).
  This holds across instances too: see presence, below.
- **Presence in Redis:** who is online, in which cohort (and later which
  space), per account: the live connection and the instance holding it. Each
  entry expires `WORLD_PRESENCE_TTL_SECONDS` after its instance stops renewing
  it, so a crashed instance's people drop out on their own. When a connection
  takes the place of one on another instance, world publishes that on
  `world:presence:displaced`, and the other instance closes the old socket
  with `entered_elsewhere`. Without `REDIS_URL`, presence is kept in memory,
  which only works for a single instance.
- **Keeps sockets honest:**
  - a heartbeat drops sockets that stopped answering
  - follows the sign-in behind each socket rather than its fifteen-minute
    access token: signing out closes it within a heartbeat, and so does a
    sign-in that stops being refreshed
  - re-checks the accounts behind open sockets, so a suspension reaches them
    within one heartbeat
- **Movement on a tile grid:**
  - the map is the published entry map, loaded from Sanity once at startup
    through `campus-world-map`; its collision shapes become blocked tiles, and
    the `snapshot` tells clients which map and version that is
  - the server enforces walking speed
  - one avatar per account, walked by whichever socket holds its place
  - other players' moves are sent once per tick
  - a reconnect within a grace period resumes where the player stood
  - between visits, players start where they last stood in that cohort, kept
    in Redis per account and cohort (`REDIS_URL`; unset keeps nothing)
- **Limits:**
  - per-socket message size and rate
  - a cap on what may wait unsent to a client that stops reading

Not yet: more than one map, spaces, portals, live positions shared across
instances (a player who moves to another instance starts from their last
saved position), or audio and video.

## Running it

From the repo root:

```bash
pnpm dev:world      # builds @campus/session and world, then recompiles and restarts on change
pnpm build:world    # builds @campus/session and world
pnpm start:world    # runs the last build
```

Or scoped here with `pnpm --filter world <script>`. Plain `build`, `dev` and
`start:dev` assume `@campus/session` is already built; the root scripts
build it for you.

Config is read from the environment; `.env.example` lists every variable with
its default and what it does. Two have no default and are required:
`AUTH_SESSION_SECRET` (the same value as campus-api's) and `DATABASE_URL` (the
same database campus-api writes; world only reads it).

`GET /health` answers while the process is up. It does not touch the
database.

## Layout

```
src/
  app.ts                Fastify app: error handling, /health, /schema.json, /docs, /docs-json, the gateway
  index.ts              boot and graceful shutdown
  infra/                env, logger, account lookup, Redis (positions, presence), the published map
  movement/             the grid and who stands where — no sockets here
  socket/
    gateway.ts          the /socket route: upgrade, heartbeat, tick, messages
    authenticate.ts     who may open a socket
    protocol.ts         every message, both directions, as zod schemas
    protocol.schema.ts  those schemas as JSON Schema, for the frontend
    frame-budget.ts     inbound rate limit
    outbound.ts         outbound backpressure
protocol.schema.json    generated — do not edit
```

## The protocol

Messages are defined once, in `src/socket/protocol.ts`. From them:

- **`protocol.schema.json`** is generated for the frontend to build types
  from. After changing `protocol.ts`, run `pnpm --filter world protocol:schema`
  and commit the result; a test fails CI if you forget.
- **`GET /schema.json`** serves that same document from the running
  instance, open to anybody, so the frontend can generate its types from the
  environment it builds against.
- **`GET /docs-json`** serves the protocol as an AsyncAPI 2.6 document,
  built by `src/socket/protocol.asyncapi.ts` from the same schemas. It adds
  the socket's address, the session cookie, and which side sends each
  message — read from the `ClientMessage` and `ServerMessage` unions, so a
  new message lands on the right side without being listed anywhere else.
- **`GET /docs`** shows that document as a page, as campus-api's `/docs`
  shows its own. The page loads AsyncAPI's viewer from a CDN
  (`src/socket/protocol.docs.ts` pins the version) and reads `/docs-json`
  from the same instance.
- **[docs/world-protocol.md](../../docs/world-protocol.md)** explains to
  client authors what the schema can't: message order, correcting a predicted
  step, limits and close codes. Update it when what a client should _do_
  changes.

## Tests

```bash
pnpm --filter world test
```

The socket tests start a real server on a random port and connect real
WebSocket clients. The account lookup is replaced by an in-memory stand-in,
so no database is needed. Each test must close its sockets: a check after
every test fails if any are left open.

Presence is Lua run inside Redis, so its tests, and the one that runs two
instances side by side, need a real Redis. They are skipped unless
`WORLD_TEST_REDIS_URL` is set; CI sets it. Locally, point it at a database
nothing else uses:

```bash
WORLD_TEST_REDIS_URL=redis://localhost:6379/15 pnpm --filter world test
```

## Deploying

See [docs/deployment.md](../../docs/deployment.md#world): the build command,
the healthcheck path, and the environment variables to set.
