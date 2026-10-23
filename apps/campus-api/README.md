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
- [Logging](#logging)
- [Telemetry (OpenTelemetry tracing)](#telemetry-opentelemetry-tracing)
- [Integration guide](#integration-guide)
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
- **Redaction**: `authorization`, `cookie`, `password`, `token` and `secret`
  fields are redacted as `[REDACTED]`.
- **Route noise**: `/v1/health`, `/docs` and `/docs-json` are excluded from
  request logging — uptime probes and the API reference say nothing useful.

### How trace IDs get into logs (no interceptor)

There is **no interceptor** involved. Trace/span IDs are attached through a pino
`mixin` configured on the HTTP logger (`logger.module.ts`). The `mixin` runs for
every log line and reads the **active span** from OpenTelemetry's async-local
context (`trace.getSpan(context.active())`). Because that context is propagated
automatically throughout the lifetime of a request (HTTP → middleware →
controller → service), any log line produced inside a request — from
`PinoLogger`, `@InjectPinoLogger`, or the auto-logged request — inherits the same
`trace_id`/`span_id`. No span is manually started or threaded through parameters;
you can just use the injected logger normally and correlation happens for free.

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

## Telemetry (OpenTelemetry tracing)

### What is instrumented

`src/infra/telemetry/telemetry.ts` boots the OpenTelemetry Node SDK with the
standard **HTTP** and **Express** auto-instrumentations. This gives you, for
free:

- an **HTTP server span** per incoming request (method, route, status code,
  duration)
- client spans for outbound HTTP calls made by the service
- child spans for Express routing layers when custom spans are created later

The span lifecycle follows the request through the whole process using the
async-local context manager — the same mechanism the logger `mixin` relies on.

### Metrics

When `FF_OTEL_METRICS_ENABLED=true`, the SDK also collects and exports
**Node.js runtime metrics** via `RuntimeNodeInstrumentation` (event-loop lag,
GC/CPU, heap, event-loop utilization, process metrics). The metric reader is
built from the standard `OTEL_METRICS_EXPORTER` env var (default `otlp`), so
metrics flow to the same OTLP endpoint as traces — with `FF_OTEL_METRICS_ENABLED=false`
the metric reader is disabled and the runtime instrumentation is skipped, while
traces continue independently.

### Why telemetry starts before Nest

`initTelemetry()` runs at the very top of `bootstrap()` in `src/main.ts`,
**before** `NestFactory.create()`. Auto-instrumentations patch Node.js modules
at load time, so the SDK must be started before the framework and its transports
are instantiated. If it were started after, the HTTP/Express patches would miss
already-loaded modules and no spans would be captured.

### Startup sequence

1. Validate environment variables (`loadEnv()`).
2. `initTelemetry()` — start OTel SDK (unless `FF_OTEL_ENABLED=false`).
3. `NestFactory.create()` with `bufferLogs: true` (pino output is buffered until
   the logger is attached so no framework logs are lost).
4. `app.useLogger(app.get(Logger))` — Nest logger routes through pino.
5. Global pipes, exception filters, OpenAPI/Scalar docs, listen.

### Configuration

The app-owned knobs are the `FF_`-prefixed validated flags in the `Env` class:

| Variable                  | Default       | Meaning                                                                                                                         |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `FF_OTEL_ENABLED`         | `true`        | Master switch. `false` fully skips SDK startup.                                                                                 |
| `FF_OTEL_METRICS_ENABLED` | `true`        | Enable Node.js runtime metrics. `false` keeps traces on but disables the metric reader and the runtime metrics instrumentation. |
| `OTEL_SERVICE_NAME`       | `campus-api`  | Value reported as `service.name` on every span.                                                                                 |
| `DEPLOYMENT_ENVIRONMENT`  | `development` | Value reported as `deployment.environment`.                                                                                     |

The **exporter endpoint and headers are NOT hardcoded**. The exporter
is constructed with no arguments (`telemetry.ts`), which makes the OTel SDK fall
back to the standard OpenTelemetry **environment variables**, read straight from
`process.env` (this is why they are not part of the validated `Env` class):

| Variable                             | Meaning                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Base URL of your OTLP endpoint (e.g. `http://localhost:4318`). The SDK appends `/v1/traces`.  |
| `OTEL_EXPORTER_OTLP_HEADERS`         | Extra headers sent with every export, e.g. `api-key=...` (comma-separated `key=value` pairs). |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal-specific endpoint (takes precedence).                                                  |
| `OTEL_EXPORTER_OTLP_COMPRESSION`     | `gzip` or `none` for the export payload.                                                      |

If none are set, the SDK defaults to `http://localhost:4318/v1/traces` — which is
exactly the local Collector in `docker-compose.local.yml`, so **local tracing
works with zero configuration**.

### Pointing at different backends

Because endpoints and headers come from the environment, switching backends is a
deployment concern, not a code change.

**Local OpenTelemetry Collector** (default, no vars needed):

```bash
$ docker compose -f docker-compose.local.yml up -d otel-collector
```

The Collector config (`otel-collector.yaml` at repo root) receives OTLP on
4317/4318 and prints spans to its debug console.

**Grafana Cloud**, where deployed environments send theirs (setup in
[docs/grafana.md](../../docs/grafana.md)):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp \
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<token> \
pnpm run start:prod
```

The exporter sends `POST /v1/traces` with a `content-type:
application/x-protobuf` body and the headers given.

### The `FF_OTEL_ENABLED` switch

When `FF_OTEL_ENABLED=false`, `initTelemetry` constructs the SDK but **never calls
`start()`**. This is deliberate:

- Instrumentations are never applied.
- No global tracer provider is registered, so the OTel API uses its no-op
  default.
- The pino `mixin` finds no active span, so log lines carry no `trace_id` /
  `span_id`.

In other words, disabled means a complete opt-out — not "trace and discard".
There is a single startup path (`sdk.start()` inside `initTelemetry`), so nothing
is started elsewhere when disabled.

### Graceful shutdown

On `SIGTERM` the SDK's `shutdown()` is awaited so in-flight spans are flushed
before the process exits.

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

## License

MIT
