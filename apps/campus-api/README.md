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

| Variable                          | Default                                   | Description                          |
| --------------------------------- | ----------------------------------------- | ------------------------------------ |
| `NODE_ENV`                        | *(unset)*                                 | Node runtime mode; **the app itself never branches on this** — feature behavior comes from the explicit `FF_` flags below |
| `PORT`                            | `3000`                                    | HTTP port                            |
| `DATABASE_URL`                    | `postgresql://postgres:postgres@localhost:5432/campus` | Postgres connection string |
| `FF_LOG_LEVEL`                    | `info`                                    | Minimum pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `FF_LOG_PRETTY`                   | `false`                                   | Enable human-readable pino-pretty output (`true`) or JSON lines (`false`) |
| `DEPLOYMENT_ENVIRONMENT`          | `development`                             | Label sent with traces (`deployment.environment`) |
| `OTEL_SERVICE_NAME`               | `campus-api`                              | Service name sent with traces        |
| `FF_OTEL_ENABLED`                 | `true`                                    | Master switch for OpenTelemetry      |
| `FF_OTEL_METRICS_ENABLED`         | `true`                                    | Enable Node.js runtime metrics export |

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
- **LiveKit** — realtime video/audio (ports 7880-7882, 50000-60000 UDP)
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
$ pnpm run db:studio     # open Drizzle Studio
```

## Logging

Logging uses **pino** through **nestjs-pino** (`src/infra/logger/logger.module.ts`).

Key behaviors:

- **Structured JSON** by default; pretty single-line output when `FF_LOG_PRETTY=true`.
- **Correlation IDs**: every request gets an `x-correlation-id`. If the caller
  provides one, it is honored and echoed back on the response; otherwise a UUID
  is generated. All log lines for that request carry it under `req.id`.
- **Trace correlation**: when OpenTelemetry is enabled, every log line also
  carries `trace_id` and `span_id` extracted from the active span, so logs and
  traces can be joined in an observability backend.
- **Log level** comes from `FF_LOG_LEVEL` (default `info`); use `trace`/`debug` for
  verbose local debugging without changing runtime mode.
- **Redaction**: `authorization`, `cookie`, `password`, `token` and `secret`
  fields are redacted as `[REDACTED]`.
- **Route noise**: health/docs endpoints (`/docs`, `/reference`) are excluded
  from request logging.

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
  constructor(@InjectPinoLogger(SomeService.name) private readonly logger: PinoLogger) {}

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

| Variable          | Default      | Meaning                                              |
| ----------------- | ------------ | ---------------------------------------------------- |
| `FF_OTEL_ENABLED` | `true`       | Master switch. `false` fully skips SDK startup.      |
| `FF_OTEL_METRICS_ENABLED` | `true` | Enable Node.js runtime metrics. `false` keeps traces on but disables the metric reader and the runtime metrics instrumentation. |
| `OTEL_SERVICE_NAME` | `campus-api` | Value reported as `service.name` on every span.     |
| `DEPLOYMENT_ENVIRONMENT` | `development` | Value reported as `deployment.environment`.  |

The **exporter endpoint and headers are NOT hardcoded**. The exporter
is constructed with no arguments (`telemetry.ts`), which makes the OTel SDK fall
back to the standard OpenTelemetry **environment variables**, read straight from
`process.env` (this is why they are not part of the validated `Env` class):

| Variable                          | Meaning                                          |
| --------------------------------- | ------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | Base URL of your OTLP endpoint (e.g. `http://localhost:4318`). The SDK appends `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS`      | Extra headers sent with every export, e.g. `api-key=...` (comma-separated `key=value` pairs). |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal-specific endpoint (takes precedence).    |
| `OTEL_EXPORTER_OTLP_COMPRESSION`  | `gzip` or `none` for the export payload.         |

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

**New Relic** (example):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net:4318 \
OTEL_EXPORTER_OTLP_HEADERS=api-key=YOUR_NR_LICENSE_KEY \
pnpm run start:prod
```

The exporter sends `POST /v1/traces` with a `content-type:
application/x-protobuf` body carrying the `api-key` header — this has been
verified against a mock OTLP receiver.

> Same pattern applies to Grafana Tempo, Jaeger, SigNoz, Honeycomb, etc. — set
> the endpoint and any required headers and restart.

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

## License

MIT