# Deployment

Single Railway project, two Environments (`staging`, `production`), each
with its own independent services and Postgres database — nothing shared
across environments.

## Services

| Service | Public domain? |
| --- | --- |
| `campus-api` (`apps/campus-api`) | Yes |
| `world` (`apps/world`) | Not yet — no consumer calls it externally |
| `frontend` (separate repo) | Yes |
| `postgres` (Railway plugin) | No — internal + admin proxy URL only |

All app services use **Root Directory `/`** (repo root), not their
subfolder — required so Nixpacks sees the shared pnpm workspace lockfile.

## campus-api

- Build: `pnpm install --frozen-lockfile && pnpm --filter campus-api... build`
  — the trailing `...` builds the workspace packages campus-api depends on
  (`@campus/session`), which ship compiled output. Without it the API starts
  and then cannot resolve them.
- Start: `pnpm --filter campus-api start:prod`
- Env vars: `DATABASE_URL` (Postgres plugin reference), `NODE_ENV=production`,
  `FF_LOG_PRETTY=false`, `FF_OTEL_ENABLED=false` (no collector deployed),
  `FF_POSTHOG_ENABLED=true` + `POSTHOG_PROJECT_TOKEN` + `POSTHOG_HOST` (see
  [posthog.md](./posthog.md) — region must match the frontend's project),
  `DEFAULT_ADMIN_EMAIL` (address promoted to admin by the pre-deploy seed;
  set it per environment before the first deploy, or the seed step fails),
   `CORS_ORIGINS` (the frontend origin for that environment — without it every
   browser call is blocked), `TRUST_PROXY_HOPS=1` (Railway runs one proxy;
   without it the rate limiter treats all traffic as a single client),
   `APP_PUBLIC_URL` (invite-link base, `{base}/invite?token=<raw>` — set it to
   the frontend origin for that environment; required, boot fails without it),
   `INVITE_TTL_DAYS` (invite lifetime in days; optional, defaults to 7).
   `PORT` is injected by Railway, not set manually.
- Google sign-in stays off unless `FF_GOOGLE_AUTH_ENABLED=true`, which then
  requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
  (this API, matching a registered redirect URI byte for byte) and two
  different 32-character secrets: `AUTH_STATE_SECRET` and
  `AUTH_SESSION_SECRET`. Session lifetimes are `AUTH_SESSION_TTL_MINUTES`
  (720) and `AUTH_PROVISIONAL_TTL_MINUTES` (30).
- The session cookie is cross-site once both sides are on https, so
  `APP_PUBLIC_URL` and `CORS_ORIGINS` must name the frontend, and the frontend
  has to send its requests with credentials.
- Migrations and seeding run via a pre-deploy step:
  `pnpm --filter campus-api db:migrate && pnpm --filter campus-api db:seed`.
  Seeding is deliberately **not** part of app boot — the API must not need a
  writable database to report healthy, and two replicas starting at once must
  not race each other.
- `/docs` and `/docs-json` are unauthenticated by decision.

## world

- Build: `pnpm --filter world build` / Start: `pnpm --filter world start`
- No database dependency, no extra env vars beyond what Railway injects.

## postgres

- One instance per environment. `campus-api` uses the **internal**
  connection string; the public/proxy one is for local admin tasks only
  (`drizzle-kit studio`, manual migrations) — never the deployed app.

## world

- Build: `pnpm --filter world... build` / Start: `pnpm --filter world start:prod`
- Env vars: `AUTH_SESSION_SECRET` (**the same value campus-api signs with**, or
  no socket can authenticate), `CORS_ORIGINS` (a WebSocket upgrade is exempt
  from CORS, so unset means no browser can connect), `DATABASE_URL` (read-only:
  world re-checks that the account behind a token still exists and is not
  suspended, so a ban reaches open sockets instead of waiting out the token),
  `WORLD_DB_POOL`, `WORLD_HEARTBEAT_SECONDS`, `WORLD_MAX_MESSAGE_BYTES`,
  and the placeholder map until real maps load: `WORLD_MAP_WIDTH`,
  `WORLD_MAP_HEIGHT`, `WORLD_SPAWN_X`, `WORLD_SPAWN_Y`, `WORLD_STEP_MS`, `WORLD_TICK_MS` (all
  defaulted).
- Positions are per-process state too, and are lost on a restart or redeploy:
  everyone reconnects at the spawn tile.
- Sockets are per-process state. Running more than one instance needs the
  presence work first, or two tabs may land on different instances and
  disagree about who is online.

## LiveKit

Decided: the container in `docker-compose.local.yml` for local development,
**LiveKit Cloud** for staging and production. Railway's edge proxy does not
expose the UDP range self-hosted LiveKit needs for real WebRTC media, so
self-hosting there would give working signalling and broken audio.

That means media configuration differs by environment, and the code must not
assume otherwise:

| | Local | Staging / production |
| --- | --- | --- |
| Server | `livekit/livekit-server` container | LiveKit Cloud project |
| URL | `ws://localhost:7880` | the project's `wss://` URL |
| Credentials | the dev key pair in `livekit.yaml` | per-environment API key and secret |

A Cloud project per environment, so a staging room can never collide with a
production one. The key and secret are server-side only: clients get a
short-lived room token minted by the API, never the credentials themselves.

## Open items

- `world` has no public domain — add one once something actually calls it.
- Redis isn't provisioned (local-dev-only in `docker-compose.local.yml`);
  `world` needs it for presence before that service is deployed.
- Node version isn't pinned on Railway — set `NIXPACKS_NODE_VERSION=24` to
  match CI.
- Frontend↔backend PostHog correlation isn't wired yet — see
  [posthog.md](./posthog.md).
