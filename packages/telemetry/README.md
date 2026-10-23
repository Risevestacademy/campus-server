# Telemetry

One way to start OpenTelemetry, for campus-api and world alike: traces and
logs over OTLP, and Node's runtime metrics when asked. Where they go is set by
the standard `OTEL_EXPORTER_OTLP_*` variables; deployed environments send to
Grafana Cloud (see [docs/grafana.md](../../docs/grafana.md)).

```ts
const telemetry = startTelemetry({
  serviceName: 'campus-api',
  version: commitSha,
  environment: 'staging',
  metrics: true,
  untracedPaths: ['/v1/health'],
  instrumentations: [new ExpressInstrumentation()],
  esmModules: ['express'],
});
// …and on the way out:
await telemetry.shutdown();
```

## Start it before anything else

Instrumentation patches a module as it loads. Anything the app has already
imported when the SDK starts is never patched, and is never traced: this is
why campus-api's tracing once sent nothing at all. So each service's entry
point validates its environment, calls `startTelemetry`, and only then
imports the app, dynamically:

- campus-api: `src/main.ts`, then `src/bootstrap.ts`.
- world: `src/index.ts`, then `src/app.ts`.

Keep those entry points free of imports from the app. A file they do need,
such as a list of routes, has to import nothing that is instrumented.

## `esmModules`: the ESM hook, for the few that need it

`http`, pino, and anything else loaded through `require` are patched without
help. A package an ES module loads with `import` is not: Nest loads Express
that way, and world imports ioredis. Those go through OpenTelemetry's ESM
hook, which this registers only for the packages named in `esmModules`.

The hook could wrap every module instead, but measured on campus-api that cost
about a second of boot and a third more memory, which staging pays on every
wake. Naming the packages keeps that to the ones that need it. Without
Express in the list, spans lose their route.

## What is traced, and what is kept out

- HTTP: a server span per request, except `untracedPaths` and what is under
  them, matched regardless of case as Express matches routes. Client spans for
  outgoing `http` calls and for `fetch`, which Google, LiveKit, Resend and
  PostHog are all called through.
- A span keeps a query string's parameter names and never their values
  (`code=REDACTED&state=REDACTED`), on incoming and outgoing requests alike,
  and holds no client address.
- pino: every log line carries the request's `trace_id` and `span_id`, and is
  sent over OTLP after the logger's own redaction.

## Database queries

postgres.js has no maintained instrumentation, so `@campus/telemetry/sql`
exports `installPostgresTracing(sql)`. It hooks the one place postgres.js
runs a query, for the whole process, so every client, transaction, savepoint
and reserved connection gets one span per query, holding the statement as
sent with `$n` placeholders and, on failure, the SQLSTATE but never the
message, which can quote a value. postgres.js's own errors, such as
`CONNECTION_CLOSED`, are named in `error.type` only. Both services install it
while telemetry is on.

Cursors are left out: their query never settles. One other query never
settles: with `target_session_attrs` set (in the URL or
`PGTARGETSESSIONATTRS`), postgres.js checks each new connection with one, and
each would leave a span that never ends. Nothing sets it today.

## Paths without the SDK

`@campus/telemetry/paths` holds the path helpers both services' loggers use
too: `pathOf`, `matchesPath` and the query redaction. It imports nothing, so a
logger can use it without loading the SDK; the package root does load it, so
import the helpers from `/paths`.

## Versions

Every OpenTelemetry package here is on the same line, instrumentation
`0.222`, so one copy of the instrumentation base is shared. A library's next
release can move to a newer line: `@fastify/otel` 0.21.3 needs `0.223`. So
world pins `@fastify/otel` to exactly `0.21.2`, the last release on `0.222`,
and a caret range would quietly bring in a second copy. Move the whole line
together, and the pin with it.

## Shutdown

`shutdown()` sends what is buffered and gives up after 3 seconds, rejecting,
so an endpoint that does not answer cannot hold up an exit. Both services
call it last on the way out, and only warn if it rejects.
