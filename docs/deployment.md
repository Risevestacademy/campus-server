# Deployment

Single Railway project, two Environments (`staging`, `production`), each
with its own independent services and Postgres database — nothing shared
across environments.

## Infrastructure as code

Staging's backend services are described in
[`.railway/railway.ts`](../.railway/railway.ts) and changed through it, not
through the dashboard:

```bash
railway config plan    # what would change; touches nothing
railway config apply   # the same plan, applied after confirmation
```

- The file is a named partial, `campus-backend`. It owns `campus-api`,
  `campus-world`, Postgres, Redis and their volumes. The web app and
  storybook belong to campus-web's partial, `campus-frontends`, and are not
  declared here; a partial only touches what it declares.
- Variable names are listed, values are not: each is `preserve()`, which
  keeps whatever Railway already holds. Set or rotate a value in Railway.
- Staging only. The file refuses to plan for any other environment, because
  production has a different shape that it does not describe yet.
- A dashboard edit to something the file declares shows up as a difference
  in the next plan, and the next apply puts the file's value back.

Config as code (`railway.json`, `railway.toml`) is deprecated by Railway and
stops being read on 2026-12-01; do not add either.

## Services

| Service                          | Public domain?                       |
| -------------------------------- | ------------------------------------ |
| `campus-api` (`apps/campus-api`) | Yes                                  |
| `world` (`apps/world`)           | Yes                                  |
| `frontend` (separate repo)       | Yes                                  |
| `postgres` (Railway plugin)      | No — internal + admin proxy URL only |
| `redis` (Railway Redis)          | No — internal only                   |

All app services use **Root Directory `/`** (repo root), not their
subfolder — required so Railway's builder (Railpack) sees the shared pnpm
workspace lockfile.

Every build command ends in `--filter <app>... build`. The trailing `...`
builds the workspace packages the app depends on (`@campus/session`) first;
they ship compiled output, so without it the build fails with
`Cannot find module '@campus/session'`.

Each service should set these **watch paths**, so a commit redeploys only
what it can affect. Both include the shared package and the root workspace files, since a
change to either reaches both apps:

```
/apps/<app>/**
/packages/session/**
/package.json
/pnpm-lock.yaml
/pnpm-workspace.yaml
```

## campus-api

- Build: `pnpm install --frozen-lockfile && pnpm --filter campus-api... build`
  — the trailing `...` builds the workspace packages campus-api depends on
  (`@campus/session`), which ship compiled output. Without it the API starts
  and then cannot resolve them.
- Start: `node --max-old-space-size=128 --max-semi-space-size=2 apps/campus-api/dist/main.js`
  — `node` directly, because started through pnpm the wrapper stays alive as
  the parent and holds about as much memory as the API. The flags cap V8's
  heap, which otherwise grows to fit a container far larger than the API
  needs; on the command rather than in `NODE_OPTIONS` so the pre-deploy step
  does not run under them. If the logs ever show `Reached heap limit`, raise
  the first one.
- Serverless on staging: the API sleeps once it has sent nothing for a few
  minutes and wakes on the next request, from the internet or from the web
  app over the private network. The first request after a sleep is slow and
  may answer 502. Anything that keeps sending keeps it awake, which is why
  the database pool closes idle connections and why nothing here should
  poll; a signed-in browser refreshing its token also wakes it.
- Healthcheck path: `/v1/health`
- Env vars: `DATABASE_URL` (Postgres plugin reference), `NODE_ENV=production`,
  `FF_LOG_PRETTY=false`, `FF_OTEL_ENABLED=false` (no collector deployed),
  `FF_POSTHOG_ENABLED=true` + `POSTHOG_PROJECT_TOKEN` + `POSTHOG_HOST` (see
  [posthog.md](./posthog.md) — region must match the frontend's project),
  `DEFAULT_ADMIN_EMAIL` (the admins the pre-deploy seed creates or promotes:
  one Google address, or several separated by commas; set it per
  environment before the first deploy, or the seed step fails),
  `CORS_ORIGINS` (the frontend origin for that environment — without it every
  browser call is blocked), `TRUST_PROXY_HOPS=1` (Railway runs one proxy;
  without it the rate limiter treats all traffic as a single client),
  `APP_PUBLIC_URL` (invite-link base, `{base}/invitation?token=<raw>` — set it to
  the frontend origin for that environment; required, boot fails without it),
  `INVITE_TTL_DAYS` (invite lifetime in days; optional, defaults to 7),
  `FF_EMAIL_ENABLED=true` + `RESEND_API_KEY` + `EMAIL_FROM` (the invite
  email, e.g. `Campus by Rise <invites@campusbyrise.com>`),
  `RESEND_INVITE_TEMPLATE_ID`, `RESEND_INVITE_ADMIN_TEMPLATE_ID` and
  `RESEND_INVITE_GUEST_TEMPLATE_ID` (the Resend templates the invite email is
  sent with, by id or alias; optional, unset sends the email built into the
  API).
  `PORT` is injected by Railway, not set manually.
- Google sign-in stays off unless `FF_GOOGLE_AUTH_ENABLED=true`, which then
  requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
  (this API, matching a registered redirect URI byte for byte) and two
  different 32-character secrets: `AUTH_STATE_SECRET` and
  `AUTH_SESSION_SECRET`. Lifetimes: access tokens `AUTH_SESSION_TTL_MINUTES`
  (15), refresh tokens `AUTH_REFRESH_TTL_DAYS` (30), provisional sessions
  `AUTH_PROVISIONAL_TTL_MINUTES` (30). See [auth-flow.md](./auth-flow.md) for
  refresh and sign-out. The access-token lifetime is capped at 15 minutes by
  the shared session policy in `@campus/session`: campus-api refuses to boot
  above it, and world refuses a refresh window shorter than it plus two
  minutes, since world relies on sign-ins being refreshed that often.
- `GOOGLE_MOBILE_CLIENT_IDS` (optional): the Google client ids of the native
  apps, comma-separated, from the same Google project as `GOOGLE_CLIENT_ID`.
  A native app signs in by posting an id_token to `/v1/auth/google/token`.
  A token is accepted when it is addressed to one of the clients named here
  or to the web client, and refused otherwise. Unset, only the web client's
  tokens are accepted.
- `AUTH_COOKIE_DOMAIN` (optional): the parent domain the access cookie is
  shared under, so world on its own subdomain receives it — for example
  `campus.example`. Only `campus_session` gets it; the refresh and state
  cookies stay host-only. Boot fails if it does not cover both
  `APP_PUBLIC_URL` and `GOOGLE_CALLBACK_URL`, because a browser would drop the
  cookie without saying so. campus-web's proxy must pass the `Domain`
  attribute through rather than strip it.
- `APP_PUBLIC_URL` is also where sign-in lands: `/`, `/invitation` or
  `/sign-in?error=<code>`. The frontend needs all three routes.
- Where the frontend and the API live decides whether the session cookie
  works at all — see [Domains and cookies](#domains-and-cookies) before
  choosing hostnames.
- Migrations and seeding run via a pre-deploy step:
  `pnpm --filter campus-api db:migrate && pnpm --filter campus-api db:seed`.
  Seeding is deliberately **not** part of app boot — the API must not need a
  writable database to report healthy, and two replicas starting at once must
  not race each other.
- `/docs` and `/docs-json` are unauthenticated by decision.

## Domains and cookies

The session lives in httpOnly cookies set by campus-api. They only reach the
API from the frontend's `fetch` calls if the browser considers the two the
same site, or is willing to send third-party cookies — and Safari and
Firefox are not.

**Railway's own domains are separate sites.** `up.railway.app` is on the
public-suffix list, exactly like `github.io`, so `campus-web.up.railway.app`
and `campus-api.up.railway.app` are as unrelated to a browser as two
different companies. campus-api detects this and marks the cookie
`SameSite=None`, which gives:

| Browser             | Cookie on the frontend's calls           | Result                                       |
| ------------------- | ---------------------------------------- | -------------------------------------------- |
| Chrome              | Sent (third-party cookies still allowed) | Works                                        |
| Safari              | Blocked outright                         | Every call 401s after a "successful" sign-in |
| Firefox             | Partitioned away, never sent             | Same as Safari                               |
| Any, private window | Usually blocked                          | Same as Safari                               |

So the browser must never call campus-api on its own Railway domain. It
doesn't: campus-web proxies every call through its own host.

### How campus-web reaches the API: its own proxy

campus-web never calls campus-api from the browser. Its route handler at
`app/api/[...path]/route.ts` forwards `/api/*` on the frontend's host to
`API_BASE_URL` (campus-api's Railway private URL), so `/api/v1/auth/me` in the
browser is `/v1/auth/me` here. The browser only ever talks to one host, the
cookies are first-party, and it works on Railway's domains today.

campus-api's settings for this:

| Variable              | Value                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_PUBLIC_URL`      | `https://<web>.up.railway.app`                                                                                                                                                                                                                 |
| `GOOGLE_CALLBACK_URL` | `https://<web>.up.railway.app/api/v1/auth/google/callback` — through the proxy, not campus-api's own host. Register the same URI on the Google client. Because this host matches `APP_PUBLIC_URL`, campus-api picks `SameSite=Lax` on its own. |
| `CORS_ORIGINS`        | `https://<web>.up.railway.app`                                                                                                                                                                                                                 |
| `TRUST_PROXY_HOPS`    | `1`, provided the proxy forwards `X-Forwarded-For` — see below.                                                                                                                                                                                |

campus-api's public domain is then only needed for `/docs`.

The proxy has to carry the auth flow through, not just JSON. It must:

- **Forward the three auth cookies** upstream — `campus_session`,
  `campus_refresh`, `campus_oauth_state` — and pass each one's `Set-Cookie`
  back to the browser, not only one named cookie.
- **Re-scope cookie paths under `/api`.** campus-api scopes the refresh and
  state cookies to `Path=/v1/auth`, but the browser sees `/api/v1/auth`, so the
  proxy must rewrite them to `Path=/api/v1/auth` (and a clearing
  `Set-Cookie` the same way, or logout leaves them behind). `campus_session`
  is `Path=/` and needs nothing.
- **Pass `Location` through on redirects.** `GET /v1/auth/google` answers 302
  to `accounts.google.com`, and the callback answers 302 to `APP_PUBLIC_URL`.
  Without `Location` the browser has nowhere to go. Allowing those two
  destinations keeps the existing guard against open redirects.
- **Forward `X-Forwarded-For`** as it arrived from Railway's edge. Otherwise
  every request reaches campus-api from the proxy's own address, and the rate
  limiter (100 requests a minute per client) treats all users as one.

The proxy already refuses cross-origin writes itself and does not forward
`Origin`, so campus-api's own Origin checks see no `Origin` and stand aside.
That is safe only as long as campus-api is not reachable from browsers
directly; keep `CORS_ORIGINS` set for when it is.

### Once the domain exists

Put the API **under** the frontend's host: `campus.example` for the web app,
`api.campus.example` for campus-api, both as Railway custom domains.
campus-api recognises one host nested under the other as the same site and
uses `SameSite=Lax`. Sibling hosts (`app.campus.example` with
`api.campus.example`) also work, since they are the same site, but campus-api
cannot prove that without a public-suffix list, so it falls back to
`SameSite=None` and loses the Lax protection.

With campus-web's proxy in place nothing about that split matters: the
browser still only sees the frontend's host. Moving to the domain means
updating `APP_PUBLIC_URL`, `GOOGLE_CALLBACK_URL` (and the Google client's
redirect URIs) and `CORS_ORIGINS` to the new host together.

## postgres

- One instance per environment. `campus-api` uses the **internal**
  connection string; the public/proxy one is for local admin tasks only
  (`drizzle-kit studio`, manual migrations) — never the deployed app.

## redis

- One instance per environment, like Postgres. Only `world` connects, over
  the **internal** URL.
- It holds state that is cheap to lose but should not vanish on every
  restart: each player's last position between visits, who is online where
  (presence), and the messages between world instances.
- **Persistence on.** A restart that empties Redis sends everyone back to
  the spawn tile. Snapshots (RDB) are enough; append-only is fine too.
- **Eviction `noeviction` (Redis's default).** Any other policy would drop
  positions and presence to make room under memory pressure, silently —
  `volatile-*` included, since every key world writes carries a TTL
  (positions ~90 days, presence a minute).
- Locally, the `redis` container in `docker-compose.local.yml` already runs
  this way: append-only on, default eviction.
- world reads it as `REDIS_URL`. Unset, world still runs and keeps nothing
  between visits, and keeps presence in memory — fine for one instance, wrong
  for more. Redis going down never keeps anybody out: a position that cannot
  be read means starting at the spawn, one that cannot be written is lost,
  and somebody whose presence cannot be written is put back by the next
  renewal once Redis returns.

## world

- Build: `pnpm install --frozen-lockfile && pnpm --filter world... build`
- Start: `node --max-old-space-size=96 --max-semi-space-size=2 apps/world/dist/index.js`
  — for the same reasons as campus-api's. Never serverless: it holds sockets
  open, and a sleep would drop everybody.
- Healthcheck path: `/health` (no `/v1`). It answers while the process is
  up; it does not check the database.
- Reads campus-api's tables with its own SQL (`users`, `refresh_tokens`), so
  a campus-api migration that adds a column world selects has to be applied
  before the world build that selects it starts. campus-api's pre-deploy
  step runs the migrations; when a change touches both, let campus-api
  finish deploying first. `users.session_epoch` was the first such column:
  world's account lookup fails on every socket without it.
- Env vars: `AUTH_SESSION_SECRET` (**the same value campus-api signs with**, or
  no socket can authenticate), `CORS_ORIGINS` (a WebSocket upgrade is exempt
  from CORS, so unset means no browser can connect), `DATABASE_URL` (read-only:
  world re-checks that the account behind a token still exists and is not
  suspended, so a ban reaches open sockets instead of waiting out the token).
  `PORT` is injected by Railway. `REDIS_URL` (the Redis service's internal
  URL) keeps where each player last stood between visits, and presence.
- Tuning, all defaulted — see `apps/world/.env.example`: `WORLD_DB_POOL`,
  `WORLD_HEARTBEAT_SECONDS`, the inbound limits `WORLD_MAX_MESSAGE_BYTES` and
  `WORLD_MAX_MESSAGES_PER_SECOND`, the outbound limit
  `WORLD_MAX_BUFFERED_BYTES`, movement `WORLD_STEP_MS` and `WORLD_TICK_MS`,
  the reconnect grace `WORLD_RECONNECT_GRACE_SECONDS`, saved positions
  `WORLD_POSITION_SAVE_SECONDS` and `WORLD_POSITION_TTL_DAYS`, presence
  `WORLD_PRESENCE_TTL_SECONDS`, the session refresh
  window `WORLD_SESSION_REFRESH_WINDOW_SECONDS` (at least 1020 — see below),
  and the placeholder
  map until real maps load: `WORLD_MAP_WIDTH`, `WORLD_MAP_HEIGHT`,
  `WORLD_SPAWN_X`, `WORLD_SPAWN_Y`.
- Live positions are per-process state. A reconnect within the grace resumes
  from memory; otherwise a player starts where they last stood, read from
  Redis. Positions are written when somebody's last tab closes, every
  `WORLD_POSITION_SAVE_SECONDS` for anyone who moved, and for everybody on a
  graceful shutdown — so a redeploy puts people back where they were, and a
  crash loses at most one save interval.
- Sockets are per-process state too, but presence is in Redis: each account's
  entry names its live connection and the instance holding it, so two tabs
  on different instances still leave one place, and the older one is closed
  with `entered_elsewhere`. More than one instance therefore needs
  `REDIS_URL`. What is still per-process is the live map: players on one
  instance do not see players on another yet, and somebody moving instance
  starts from their last saved position.
- Browsers reach world on its own hostname with the access cookie, once
  campus-api's `AUTH_COOKIE_DOMAIN` covers that hostname. World's
  `CORS_ORIGINS` must name the web app's origin.

## LiveKit

Decided: the container in `docker-compose.local.yml` for local development,
**LiveKit Cloud** for staging and production. Railway's edge proxy does not
expose the UDP range self-hosted LiveKit needs for real WebRTC media, so
self-hosting there would give working signalling and broken audio.

That means media configuration differs by environment, and the code must not
assume otherwise:

|             | Local                              | Staging / production               |
| ----------- | ---------------------------------- | ---------------------------------- |
| Server      | `livekit/livekit-server` container | LiveKit Cloud project              |
| URL         | `ws://localhost:7880`              | the project's `wss://` URL         |
| Credentials | the dev key pair in `livekit.yaml` | per-environment API key and secret |

A Cloud project per environment (`campus-dev`, `campus-staging`,
`campus-production`), so a staging room can never collide with a production
one. The key and secret are server-side only: clients get a short-lived room
token, never the credentials themselves.

**world mints the room tokens.** A token is permission to hear a room, and
only world knows who is actually standing in which space: campus-api could
check that someone _may_ enter a space, not that they did. world also sees
the exit, so it can remove the participant through LiveKit's server API at
once instead of waiting for the token to run out, and it owns the lifecycle
of a space's room (open on first entry, close on last exit). So the LiveKit
key and secret belong to world, and campus-api never holds them.

The minting itself lives in `packages/media` (`@campus/media`). Its secret
must be at least 32 characters, and it refuses anything shorter. world will
read `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` once rooms per
space or the pre-join network check land; until then, set them on world's
Railway service so they are ready.

To try the media server by hand, mint a token and join from any LiveKit
client, such as LiveKit's hosted Meet page:

```bash
pnpm --filter @campus/media build
pnpm --filter @campus/media room-token --identity ada --room spike
```

It defaults to the local server and the dev key in `livekit.yaml`; point it
at another server with `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` — all three, or none.

## Open items

- `world` has no public domain — add one once something actually calls it.
- Production is not described in `.railway/railway.ts`. It has no Redis, no
  variables on campus-api or world, and older build settings; bring it in
  line before the file is taught about it.
- Node version isn't pinned on Railway. Railpack takes it from `engines.node`
  in the root `package.json`, which says `>=20`, so it builds on Node 20
  while CI runs 24. Pin it (for example `"node": "24.x"`) to match.
- World on Railway's own domain cannot get the cookie: `up.railway.app` is a
  public suffix, so no `Domain` can span two services there. It works once
  both sit under the custom domain with `AUTH_COOKIE_DOMAIN` set.
- Frontend↔backend PostHog correlation isn't wired yet — see
  [posthog.md](./posthog.md).
