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

- Build: `pnpm install --frozen-lockfile && pnpm --filter campus-api build`
- Start: `pnpm --filter campus-api start:prod`
- Env vars: `DATABASE_URL` (Postgres plugin reference), `NODE_ENV=production`,
  `FF_LOG_PRETTY=false`, `FF_OTEL_ENABLED=false` (no collector deployed),
  `FF_POSTHOG_ENABLED=true` + `POSTHOG_PROJECT_TOKEN` + `POSTHOG_HOST` (see
  [posthog.md](./posthog.md) — region must match the frontend's project).
  `PORT` is injected by Railway, not set manually.
- Migrations run via a pre-deploy step: `pnpm --filter campus-api db:migrate`.
- `/docs` and `/docs-json` are unauthenticated by decision.

## world

- Build: `pnpm --filter world build` / Start: `pnpm --filter world start`
- No database dependency, no extra env vars beyond what Railway injects.

## postgres

- One instance per environment. `campus-api` uses the **internal**
  connection string; the public/proxy one is for local admin tasks only
  (`drizzle-kit studio`, manual migrations) — never the deployed app.

## Open items

- `world` has no public domain — add one once something actually calls it.
- Redis and LiveKit aren't provisioned (local-dev-only in
  `docker-compose.local.yml`); if LiveKit is ever needed, prefer LiveKit
  Cloud over self-hosting on Railway (its edge proxy doesn't expose the UDP
  range self-hosted LiveKit needs for real WebRTC media).
- Node version isn't pinned on Railway — set `NIXPACKS_NODE_VERSION=24` to
  match CI.
- Frontend↔backend PostHog correlation isn't wired yet — see
  [posthog.md](./posthog.md).
