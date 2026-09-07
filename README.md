# campus-server

Monorepo for the campus platform. TypeScript throughout, managed with
[pnpm workspaces](https://pnpm.io/workspaces).

## Layout

```
apps/
  campus-api/   NestJS HTTP API (primary service)
  world/        Minimal Node + TypeScript + Fastify service
docker-compose.local.yml   Local dev dependencies (Postgres, Redis, LiveKit, OTel Collector)
livekit.yaml               LiveKit server config
otel-collector.yaml        Local OpenTelemetry Collector config
```

## Packages

| App           | Stack          | Default port | README                                    |
| ------------- | -------------- | ------------ | ----------------------------------------- |
| `campus-api`  | NestJS 12      | `3000`       | [apps/campus-api/README.md](apps/campus-api/README.md) |
| `world`       | Fastify 5      | `3001`       | [apps/world/README.md](apps/world/README.md) |

## Prerequisites

- Node.js 24
- pnpm 10
- Docker (for local infra and the OTel Collector)

## Getting started

```bash
# install all workspace dependencies
pnpm install

# start local infrastructure (Postgres, Redis, LiveKit, OTel Collector)
docker compose -f docker-compose.local.yml up -d

# run every app in dev/watch mode
pnpm dev

# run one app
pnpm --filter campus-api start:dev
pnpm --filter world start:dev
```

## Common commands

From the repo root, scoped to a single package:

```bash
pnpm --filter campus-api build
pnpm --filter campus-api lint
pnpm --filter campus-api test
pnpm --filter campus-api db:migrate   # Drizzle migrations
```

Or across all packages at once:

```bash
pnpm build
pnpm lint
pnpm test
```

## Local infrastructure

`docker-compose.local.yml` provides everything local development needs:

| Service            | Port(s)                                    |
| ------------------ | ------------------------------------------ |
| Postgres 18        | `5432`                                     |
| Redis 7            | `6379`                                     |
| LiveKit            | `7880` TCP, `7881` TCP, `7882` UDP, `50000-60000` UDP |
| OpenTelemetry Collector | `4317` (gRPC), `4318` (HTTP)         |

## Committing

The repo uses [husky](https://typicode.github.io/husky/) and
[commitlint](https://commitlint.js.org/) with the conventional commits config.
Every commit message must follow the
[`<type>: <subject>`](https://www.conventionalcommits.org/) format, for example:

```text
feat: add health endpoint
fix(api): correct validation error details
chore: bump dependencies
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. A `commit-msg` hook enforces this on every commit;
invalid messages are rejected before the commit is created. The config lives in
`commitlint.config.mjs`.

## Documentation

Each app documents itself in its own README:

- **campus-api** — setup, environment variables, feature flags, logging,
  OpenTelemetry tracing/metrics, database migrations, and integration docs.
- **world** — a minimal Fastify service; see its README for details.

Integration and OpenAPI guidance for the API lives in
[apps/campus-api/docs/intro.md](apps/campus-api/docs/intro.md).