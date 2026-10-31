# campus-api

NestJS backend for the campus application.

> **Integrating with the API?** Start with the
> [Integration Guide](docs/intro.md) — it covers the shared error contract,
> pagination, OpenAPI/Scalar conventions, and how routes are documented.

## Table of contents

- [Prerequisites](#prerequisites)
- [Project setup](#project-setup)
- [Compile and run](#compile-and-run)
- [Environment variables](#environment-variables)
- [Databases & infra](#databases--infra)
- [Role guards](#role-guards)
- [Audit log](#audit-log)
- [Maps](#maps)
- [Feedback](#feedback)
- [Calls](#calls)
- [Calendar](#calendar)
- [Dashboard](#dashboard)
- [Logging](#logging)
- [Telemetry (OpenTelemetry tracing)](#telemetry-opentelemetry-tracing)
- [Integration guide](#integration-guide)
- [Documenting DTOs](#documenting-dtos)
- [Run tests](#run-tests)
- [License](#license)

## Prerequisites

- Node.js 24
- pnpm 10
- Docker (for local Postgres, Redis, LiveKit, and the OpenTelemetry Collector)

## Project setup

```bash
$ pnpm install
```

## Compile and run

```bash
# development (watch mode)
$ pnpm run start:dev

# production mode
$ pnpm run build && pnpm run start:prod
```

## Environment variables

All configuration is validated at startup by a class-validator `Env` class
(`src/infra/config/env.ts`). Invalid values cause the app to refuse to boot with
a clear error.

| Variable                          | Default                                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                        | _(unset)_                                              | Node runtime mode; **the app itself never branches on this** — feature behavior comes from the explicit `FF_` flags below                                                                                                                                                                                                                                                                                                                  |
| `PORT`                            | `3000`                                                 | HTTP port                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_URL`                    | `postgresql://postgres:postgres@localhost:5432/campus` | Postgres connection string                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DEFAULT_ADMIN_EMAIL`             | _(unset)_                                              | The **super admins** to create or promote: one address, or several separated by commas. Read only by `pnpm db:seed` — the API never reads it; seeding fails if unset A super admin has every admin power and cannot be demoted through the API. Removing an address from the list does not take the role away: that needs a database edit                                                                                                  |
| `APP_PUBLIC_URL`                  | _(required, no default)_                               | Base URL for shareable invite links (`{base}/invitation?token=<raw>`). Boot fails without it — no silent fallback                                                                                                                                                                                                                                                                                                                          |
| `INVITE_TTL_DAYS`                 | `7`                                                    | Days until a new invite expires when the request omits `expiresAt`; also the ceiling any caller-supplied `expiresAt` is clamped to                                                                                                                                                                                                                                                                                                         |
| `FF_EMAIL_ENABLED`                | `false`                                                | Emails each new invite's link through Resend. When `true`, `RESEND_API_KEY` and `EMAIL_FROM` are required and the app refuses to boot without them. Off, invites still work and the create response says `emailStatus: disabled`                                                                                                                                                                                                           |
| `RESEND_API_KEY`                  | _(unset)_                                              | Resend API key (`re_…`), one per environment                                                                                                                                                                                                                                                                                                                                                                                               |
| `EMAIL_FROM`                      | _(unset)_                                              | Sender, as an address or `Name <address>`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RESEND_INVITE_TEMPLATE_ID`       | _(unset)_                                              | Resend template the invite email is sent with, by id or alias. Unset, the email built into the API is sent. The template has to be published and declare the variables the API sends                                                                                                                                                                                                                                                       |
| `RESEND_INVITE_ADMIN_TEMPLATE_ID` | _(unset)_                                              | Template for an admin invite that names no cohort. Used only when `RESEND_INVITE_TEMPLATE_ID` is set; unset, those invites use the standard template                                                                                                                                                                                                                                                                                       |
| `RESEND_INVITE_GUEST_TEMPLATE_ID` | _(unset)_                                              | Template for a guest invite. Used only when `RESEND_INVITE_TEMPLATE_ID` is set; unset, those invites use the standard template                                                                                                                                                                                                                                                                                                             |
| `FF_GOOGLE_AUTH_ENABLED`          | `false`                                                | Master switch for Google sign-in. When `true`, the four `GOOGLE_*` / `AUTH_*` values below are all required and the app refuses to boot without them                                                                                                                                                                                                                                                                                       |
| `GOOGLE_CLIENT_ID`                | _(unset)_                                              | OAuth **web-application** client ID. Android and iOS clients cannot perform the code exchange                                                                                                                                                                                                                                                                                                                                              |
| `GOOGLE_CLIENT_SECRET`            | _(unset)_                                              | Secret for that web client. Never ships to a mobile app                                                                                                                                                                                                                                                                                                                                                                                    |
| `GOOGLE_MOBILE_CLIENT_IDS`        | _(unset)_                                              | Optional. Google client IDs of the native apps, comma-separated, from the same Google project as `GOOGLE_CLIENT_ID`. A native app signs in by posting an id_token to `POST /v1/auth/google/token`; a token is accepted when addressed to one of these or to the web client. Unset, only the web client's tokens are accepted                                                                                                               |
| `GOOGLE_CALLBACK_URL`             | _(unset)_                                              | Where Google returns the user. Must point at **this API**, not the web app, and match a registered redirect URI exactly                                                                                                                                                                                                                                                                                                                    |
| `FF_GOOGLE_CALENDAR_ENABLED`      | `false`                                                | Lets members connect their Google Calendar, read-only. When `true`, `GOOGLE_CALENDAR_TOKEN_KEY` and `GOOGLE_CALENDAR_CALLBACK_URL` are required, and so is Google sign-in: the app refuses to boot with this on and `FF_GOOGLE_AUTH_ENABLED` off. See [Calendar](#calendar)                                                                                                                                                                |
| `GOOGLE_CALENDAR_TOKEN_KEY`       | _(unset)_                                              | 32 bytes in base64 (`openssl rand -base64 32`). Seals the members' Google refresh tokens at rest. Changing it makes every member reconnect                                                                                                                                                                                                                                                                                                 |
| `GOOGLE_CALENDAR_CALLBACK_URL`    | _(unset)_                                              | Where Google returns a member who connected their calendar: this API's `/v1/calendar/connect/callback`, registered on the same Google client as `GOOGLE_CALLBACK_URL`                                                                                                                                                                                                                                                                      |
| `AUTH_STATE_SECRET`               | _(unset)_                                              | Signs the OAuth `state` parameter; at least 32 characters. Rotating it only interrupts sign-ins already in flight                                                                                                                                                                                                                                                                                                                          |
| `AUTH_SESSION_SECRET`             | _(unset)_                                              | Signs session tokens; at least 32 characters. Separate from the state secret — rotating this one signs everybody out                                                                                                                                                                                                                                                                                                                       |
| `AUTH_SESSION_TTL_MINUTES`        | `15`                                                   | Lifetime of a full-access session                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AUTH_PROVISIONAL_TTL_MINUTES`    | `30`                                                   | Lifetime of the provisional session handed out before an invite is accepted                                                                                                                                                                                                                                                                                                                                                                |
| `AUTH_REFRESH_TTL_DAYS`           | `30`                                                   | Lifetime of the revocable refresh token stored by the API                                                                                                                                                                                                                                                                                                                                                                                  |
| `AUTH_COOKIE_DOMAIN`              | _(unset)_                                              | Optional. Parent domain the access cookie is shared under, so `world` on its own subdomain receives it (`campus.example` covers `world.campus.example`). A bare domain: no scheme, no leading dot. It must cover the hosts of both `APP_PUBLIC_URL` and `GOOGLE_CALLBACK_URL`, or the app refuses to boot. Unset keeps the cookie host-only, which is right for local development. The refresh and state cookies stay host-only either way |
| `CORS_ORIGINS`                    | _(unset)_                                              | Comma-separated browser origins allowed to call the API. Unset sends no CORS headers, which blocks browser apps                                                                                                                                                                                                                                                                                                                            |
| `TRUST_PROXY_HOPS`                | `1`                                                    | Reverse proxies in front of the app (Railway: `1`). Makes `req.ip` the real client so rate limiting buckets per user; `0` trusts none                                                                                                                                                                                                                                                                                                      |
| `SANITY_PROJECT_ID`               | _(unset)_                                              | The Sanity project the campus maps are published to. Read only by the map sync, with no token. Unset, the API runs and the sync answers 503                                                                                                                                                                                                                                                                                                |
| `SANITY_DATASET`                  | `production`                                           | The dataset the sync reads (`staging` on staging). Keep it the same as world's                                                                                                                                                                                                                                                                                                                                                             |
| `LIVEKIT_WEBHOOK_API_KEY`         | _(unset)_                                              | The key LiveKit signs its webhooks with. Both or neither with the secret; unset, `POST /v1/calls/webhook` answers 503                                                                                                                                                                                                                                                                                                                      |
| `LIVEKIT_WEBHOOK_API_SECRET`      | _(unset)_                                              | Its secret, at least 32 characters. Only verifies webhooks; world holds the key pair that mints tokens                                                                                                                                                                                                                                                                                                                                     |
| `FF_LOG_LEVEL`                    | `info`                                                 | Minimum pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal`                                                                                                                                                                                                                                                                                                                                                                |
| `FF_LOG_PRETTY`                   | `false`                                                | Enable human-readable pino-pretty output (`true`) or JSON lines (`false`)                                                                                                                                                                                                                                                                                                                                                                  |
| `DEPLOYMENT_ENVIRONMENT`          | `development`                                          | Label sent with traces (`deployment.environment`)                                                                                                                                                                                                                                                                                                                                                                                          |
| `OTEL_SERVICE_NAME`               | `campus-api`                                           | Service name sent with traces                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FF_OTEL_ENABLED`                 | `true`                                                 | Master switch for OpenTelemetry                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FF_OTEL_METRICS_ENABLED`         | `true`                                                 | Enable Node.js runtime metrics export                                                                                                                                                                                                                                                                                                                                                                                                      |
| `FF_POSTHOG_ENABLED`              | `false`                                                | Master switch for PostHog error tracking. When `true`, `POSTHOG_PROJECT_TOKEN` is required and the app refuses to boot without it                                                                                                                                                                                                                                                                                                          |
| `POSTHOG_PROJECT_TOKEN`           | _(unset)_                                              | PostHog project API key (`phc_…`). Use the project matching this environment, so frontend and backend events land together                                                                                                                                                                                                                                                                                                                 |
| `POSTHOG_HOST`                    | `https://eu.i.posthog.com`                             | PostHog ingestion host; must be `https`                                                                                                                                                                                                                                                                                                                                                                                                    |

> Other OpenTelemetry variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
> `OTEL_EXPORTER_OTLP_HEADERS`, etc.) are read directly by the OTel SDK from the
> process environment and are **not** part of the validated `Env` class. See the
> [Telemetry](#telemetry-opentelemetry-tracing) section.

## Feature flags over NODE_ENV

Configuration is intentionally **feature-flag driven**, not `NODE_ENV`-driven.
Nothing in the app reads `NODE_ENV` to decide behavior. If you want pretty logs,
debug-level output, or telemetry enabled, you set the corresponding flag —
regardless of which environment or runtime mode the process runs in. For
example, running with `NODE_ENV=production` locally and `FF_LOG_PRETTY=true` works
fine, and so does `NODE_ENV=development` with `FF_LOG_PRETTY=false` (JSON output).

## Databases & infra

Local dependencies are defined in `docker-compose.local.yml` at the repository
root:

- **Postgres 18** — primary database (port 5432)
- **Redis 7** — cache / streams (port 6379)
- **LiveKit** — realtime video/audio (ports 7880-7882; all media over UDP 7882)
- **OpenTelemetry Collector** — local trace sink (ports 4317 gRPC / 4318 HTTP)

```bash
$ docker compose -f docker-compose.local.yml up -d
```

Database migrations are managed with Drizzle. The config lives at
`src/infra/database/drizzle.config.ts` and generated migrations are committed
under `src/infra/database/migrations`.

```bash
$ pnpm run db:generate   # generate a migration from schema changes
$ pnpm run db:migrate    # apply pending migrations
$ pnpm run db:push       # push schema directly (dev only)
$ pnpm run db:seed       # upsert the DEFAULT_ADMIN_EMAIL super admins (needs a build)
$ pnpm run db:studio     # open Drizzle Studio
```

## Role guards

Authentication and cohort-role authorization are separate guards, run left to
right. A route opts in with one line, after importing `SessionModule` and
`CohortRoleModule` into its feature module:

```ts
@UseGuards(SessionGuard, ProfessorOfTrackGuard)
```

`SessionGuard` answers 401 when there is no usable session. The role guard
then answers 403 `FORBIDDEN` when the signed-in caller does not hold the role.
Roles are read from the database on every request, never from the token, the
body or the query, so ending or changing a membership takes effect on the
caller's next request.

| Guard                   | URL params            | Passes when                                                                                            |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `ProfessorOfTrackGuard` | `cohortId`, `trackId` | The caller has a live professor membership in this cohort, tied to this track, and the cohort runs it. |
| `MentorOfGroupGuard`    | `cohortId`, `groupId` | The caller is the live mentor of this group, and the group belongs to this cohort.                     |

Only route params are read: `cohortId`, `trackId` and `groupId`, as named. A
missing or malformed UUID is 400 `INVALID_ARGUMENT`. A valid id that names
nothing is 403 rather than 404, so the guard does not reveal what exists.
Admins pass these guards through `hasAdminPowers`, the same rule `AdminGuard`
uses; a caller may also be a professor in one cohort and a student in another,
and only the requested cohort is checked. A handler must not assume
`req.cohortMembership` is set: an admin passes without one, even when an id
names nothing, so the handler must still return its own 404 for a resource
that does not exist.

When a membership matches, the guard puts it on the request as
`req.cohortMembership` (`id`, `cohortId`, `role`, `cohortTrackId`,
`mentorshipGroupId`) so the handler does not repeat the query. No route uses
these guards yet.

## Audit log

Changes to the admin setup and to people's access are recorded in the
`audit_log` table, in the same transaction as the change. What is recorded,
what each field means, the personal-data rules, retention and rollout notes
are in [src/modules/audit/README.md](src/modules/audit/README.md).

## Maps

The campus maps are drawn and published elsewhere, in Sanity. The database
holds a row per map and per space, with each space's settings, and an admin
brings those rows level with what is published by calling
`POST /v1/maps/sync`. What lives where, and what the sync does and refuses,
are in [src/modules/maps/README.md](src/modules/maps/README.md).

## Feedback

Any member can send a bug, an idea or a report, and admins read them. The
routes, the limit on how much one account may send, who is told about a
report and the personal-data rules are in
[src/modules/feedback/README.md](src/modules/feedback/README.md).

## Calls

world hands people the LiveKit call for the space they stand in; campus-api
records the calls from LiveKit's webhooks: when each run of a space's room
opens and closes, who joins and leaves, and whether a camera came on. The
webhook route, how events that arrive late or twice are handled, and the
tables are in [src/modules/calls/README.md](src/modules/calls/README.md).

## Calendar

A member can connect their own Google Calendar, read-only, from inside
campus, and campus reads their events from Google when they ask. Sign-in
never asks for it. Connecting from the web and from a native app, the
outcomes the web app is sent back with, how the refresh tokens are stored
and how they are revoked when a member disconnects or their access ends are
in [src/modules/calendar/README.md](src/modules/calendar/README.md).

## Dashboard

`GET /v1/dashboard` gives admins the dashboard's figures: live members, in
total and by cohort role, and invites still waiting for an answer, across
the campus or for one cohort with `cohortId`. Who is online now is world's
to answer, at `GET /admin/online` (see
[world's README](../world/README.md#the-online-count)). The two differ for a
cohort that does not exist (404 here, `0` in world) and for suspended
accounts (members here, never online in world); the route's OpenAPI
description says so too.

## Logging

Logging uses **pino** through **nestjs-pino** (`src/infra/logger/logger.module.ts`).

Key behaviors:

- **Structured JSON** by default; pretty single-line output when `FF_LOG_PRETTY=true`.
- **Correlation IDs**: every request gets an `x-correlation-id`. If the caller
  provides one of up to 64 characters, it is honored and echoed back on the
  response; otherwise — none sent, or one longer than that — a UUID is
  generated and returned instead. All log lines for that request carry it
  under `req.id`, and audit entries written by the request carry the same
  value.
- **Trace correlation**: when OpenTelemetry is enabled, every log line also
  carries `trace_id` and `span_id` extracted from the active span, so logs and
  traces can be joined in an observability backend.
- **Log level** comes from `FF_LOG_LEVEL` (default `info`); use `trace`/`debug` for
  verbose local debugging without changing runtime mode.
- **Redaction**: `authorization`, `cookie`, `password`, `token`, `secret`,
  `email`, `idToken` and `refreshToken` fields are redacted as `[REDACTED]`,
  and request URLs are logged without their query string.
- **Route noise**: `/v1/health`, `/docs` and `/docs-json` are excluded from
  request logging — uptime probes and the API reference say nothing useful.

### How trace IDs get into logs

OpenTelemetry's pino instrumentation adds `trace_id`, `span_id` and
`trace_flags` to every log line written inside a span. The context follows the
request through middleware, controllers and services, so any line from
`PinoLogger`, `@InjectPinoLogger` or the request log carries the same
`trace_id`, with nothing passed by hand. With telemetry off, lines carry none.

Using the logger in your code:

```ts
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class SomeService {
  constructor(
    @InjectPinoLogger(SomeService.name) private readonly logger: PinoLogger,
  ) {}

  doThing() {
    this.logger.info({ userId: 42 }, 'doing a thing');
  }
}
```

## Telemetry (OpenTelemetry)

### What is sent

[`@campus/telemetry`](../../packages/telemetry) starts the OpenTelemetry Node
SDK, the same way in campus-api and world. It sends, over OTLP:

- **Traces**: an HTTP server span per request (`/v1/health` and the API
  reference excepted, the same routes the request log leaves out), Express
  spans under it with the route template, client spans for outbound HTTP and
  `fetch`, and a span per database query. A span keeps a query string's
  parameter names but not their values, a database span keeps the statement
  as sent, with `$1` placeholders but never the values, and no span holds a
  client address. A failed query is recorded by its SQLSTATE, not its
  message, which can quote the value Postgres rejected.

  postgres.js has no maintained instrumentation, so `database.module.ts`
  calls `installPostgresTracing` from `@campus/telemetry/sql` while telemetry is on.
  It hooks the one place postgres.js runs a query, so transactions,
  savepoints and reserved connections are covered; cursors are not, since
  their query never settles. world's account lookups use it too.

- **Logs**: every pino line, after redaction, linked to its trace.
- **Runtime metrics** when `FF_OTEL_METRICS_ENABLED=true`: event-loop lag,
  GC, heap and CPU.

### Why telemetry starts before the app is imported

Instrumentation patches `http`, pino and Express as they first load, so
`src/main.ts` validates the environment and starts the SDK, and only then
imports `src/bootstrap.ts`, which builds the Nest app. Imported any earlier,
they would load unpatched and nothing would be traced.

Nest loads Express through `import`, which only OpenTelemetry's ESM hook can
patch, so `main.ts` names it in `esmModules`. The hook wraps that package
alone: wrapping every module costs about a second of boot and a third more
memory.

### Configuration

The app-owned knobs are the validated flags in the `Env` class:

| Variable                  | Default       | Meaning                                                                     |
| ------------------------- | ------------- | --------------------------------------------------------------------------- |
| `FF_OTEL_ENABLED`         | `true`        | Master switch. `false` skips the SDK entirely: it is not even loaded.       |
| `FF_OTEL_METRICS_ENABLED` | `true`        | Node.js runtime metrics. `false` keeps traces and logs, and drops metrics.  |
| `OTEL_SERVICE_NAME`       | `campus-api`  | `service.name` on everything sent.                                          |
| `DEPLOYMENT_ENVIRONMENT`  | `development` | `deployment.environment` on everything sent.                                |
| `RAILWAY_GIT_COMMIT_SHA`  | _(unset)_     | `service.version`, the deployed commit. Set by Railway; `local` without it. |

Where to send comes from the standard OpenTelemetry variables, read by the SDK
straight from the environment:

| Variable                         | Meaning                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | Base URL of the OTLP endpoint. The SDK appends `/v1/traces`, `/v1/logs` and `/v1/metrics`. |
| `OTEL_EXPORTER_OTLP_HEADERS`     | Headers sent with every export, as comma-separated `key=value` pairs.                      |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `gzip` or `none` for the export payload.                                                   |

If none are set, the SDK sends to `http://localhost:4318`, which is the local
Collector in `docker-compose.local.yml`.

### Pointing at different backends

Because endpoints and headers come from the environment, switching backends is a
deployment concern, not a code change.

**Local OpenTelemetry Collector** (default, no vars needed):

```bash
$ docker compose -f docker-compose.local.yml up -d otel-collector
```

The Collector config (`otel-collector.yaml` at repo root) receives OTLP on
4317/4318 and prints what it receives to its debug console.

**Grafana Cloud**, where deployed environments send theirs (setup in
[docs/grafana.md](../../docs/grafana.md)):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp \
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<token> \
pnpm run start:prod
```

### Graceful shutdown

On `SIGTERM` the SDK's `shutdown()` is awaited, so spans and log lines still
buffered are sent before the process exits. It gives up after 3 seconds, so an
endpoint that does not answer cannot hold the exit up.

## Documenting DTOs

The `@nestjs/swagger` CLI plugin (`nest-cli.json`) documents every class in a
`*.dto.ts` file. It reads each field's type, whether it is optional or
nullable, and the limits in its `class-validator` decorators. Descriptions and
examples come from JSDoc:

```ts
/**
 * Null for an event with no title.
 * @example "Backend standup"
 */
title!: string | null;
```

Add `@ApiProperty` only for what the plugin cannot work out:

- `enum` with `enumName`, so that a generated client gets a named type.
- `format` on a response field, such as `date-time` on a `string`.
- `required` when it differs from the TypeScript type.
- `additionalProperties`, and `default`.
- A limit set by a custom validator, such as `maxLength` with `@IsCatalogCode`.
- A description or example built from code, such as `MAX_PAGE` or
  `SystemRole.User`, and `example: null`.
- A class made at runtime, such as `PaginatedPage`.

Three things drop a value without any error:

- An `@example` string with a space in it has to be in double quotes.
- An `@example` string with an apostrophe has to stay in the decorator.
- JSDoc under a `//` comment is not read, so put the `//` comment below it.

Routes are still documented by hand in each module's `docs/*.docs.ts`.

The plugin runs in `nest build` and, through `test/swagger-plugin.vite.ts`, in
the e2e suite. Unit tests do not run it, so assert on the OpenAPI document in an
e2e test.

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

### Tests that need a real PostgreSQL

Database tests run on PGlite, a whole PostgreSQL engine in the test process.
It serves one connection, so two transactions never overlap, and a test of
what a row lock prevents would pass on it with or without the lock. Those
tests (`*.pg.spec.ts`) run against a server instead, and are skipped unless
`CAMPUS_TEST_DATABASE_URL` names one. CI sets it.

Locally, point it at a database nothing else uses; the migrations are applied
to it before the tests start:

```bash
$ createdb campus_test
$ CAMPUS_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/campus_test pnpm run test
```

The tests make their own rows and clear nothing, so the database fills up
slowly; drop and recreate it whenever you like.

The files run side by side, so each keeps to its own rows. The map sync's
test cannot, since it retires every map: `vitest.config.ts` runs it on its
own once the rest have finished.

## License

MIT
