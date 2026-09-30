# world

The realtime service: one WebSocket per open tab, carrying who is on the map
and where they stand. Fastify 5 with `@fastify/websocket`, config validated
with zod at boot.

It trusts nothing from the client but a direction. The session comes from the
cookie campus-api signs, the account is re-checked against Postgres, and the
server decides every position.

## What it does today

- **Authenticates the upgrade:** the origin allowlist, then the session
  token (full-access sessions only), then the account, which must exist and
  not be suspended, then the sign-in it came from, which must still be live.
- **Keeps sockets honest:**
  - a heartbeat drops sockets that stopped answering
  - follows the sign-in behind each socket rather than its fifteen-minute
    access token: signing out closes it within a heartbeat, and so does a
    sign-in that stops being refreshed
  - re-checks the accounts behind open sockets, so a suspension reaches them
    within one heartbeat
- **Movement on a tile grid:**
  - the server enforces walking speed
  - one avatar per person, however many tabs they have open
  - other players' moves are sent once per tick
  - a reconnect within a grace period resumes where the player stood
- **Limits:**
  - per-socket message size and rate
  - a cap on what may wait unsent to a client that stops reading

Not yet: real maps, spaces, portals, presence across instances, or audio and
video.

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
  app.ts                Fastify app: error handling, /health, the gateway
  index.ts              boot and graceful shutdown
  infra/                env, logger, account lookup
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
- **[docs/world-protocol.md](../../docs/world-protocol.md)** explains to
  client authors what the schema can't: message order, correcting a predicted
  step, limits and close codes. Update it when what a client should *do*
  changes.

## Tests

```bash
pnpm --filter world test
```

The socket tests start a real server on a random port and connect real
WebSocket clients. The account lookup is replaced by an in-memory stand-in,
so no database is needed. Each test must close its sockets: a check after
every test fails if any are left open.

## Deploying

See [docs/deployment.md](../../docs/deployment.md#world): the build command,
the healthcheck path, and the environment variables to set.
