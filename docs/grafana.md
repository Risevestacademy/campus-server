# Grafana Cloud

campus-api and world send traces, logs and Node runtime metrics to Grafana
Cloud over OTLP, straight from the app: there is no collector to run. The
setup is shared, in [`packages/telemetry`](../packages/telemetry).

## What is sent

- **Traces:** an HTTP server span per request, health checks and the API
  reference excepted, with Express spans under it in campus-api, and a span
  per outgoing HTTP call. A span keeps a query string's parameter names but
  not their values, and holds no client address.
- **Logs:** every pino line, after the same redaction as the console, with the
  `trace_id` of the request that wrote it.
- **Runtime metrics:** event-loop lag, GC, heap and CPU, when
  `FF_OTEL_METRICS_ENABLED` is on.

Everything carries `service.name`, `service.version` (the deployed commit)
and `deployment.environment`.

## Setting up an environment

Do this once for staging and once for production.

1. **Create the stack.** On grafana.com, add a stack in an EU region (Railway
   runs the services in Amsterdam). Name it after the environment:
   `campus-staging`, `campus-production`. If the plan allows only one stack,
   use one for both: `deployment.environment` tells them apart.
2. **Create the OTLP token.** In the stack's Cloud Portal, open the
   OpenTelemetry tile, choose Configure, then View connection details, and
   generate a token. The page prints `OTEL_EXPORTER_OTLP_ENDPOINT` and
   `OTEL_EXPORTER_OTLP_HEADERS`. The headers hold the token: treat them as a
   secret.
3. **Declare before you set.** The variables are declared on both services in
   [`.railway/railway.ts`](../.railway/railway.ts). The file must be applied
   with them before any value is set: an apply that does not declare a
   variable removes it.
4. **Set the variables** in Railway, then redeploy. The endpoint and headers
   are the same for both services, so they can be shared variables, referenced
   as `${{shared.OTEL_EXPORTER_OTLP_ENDPOINT}}` and
   `${{shared.OTEL_EXPORTER_OTLP_HEADERS}}`.

   | Variable                      | campus-api      | campus-world |
   | ----------------------------- | --------------- | ------------ |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | from step 2     | from step 2  |
   | `OTEL_EXPORTER_OTLP_HEADERS`  | from step 2     | from step 2  |
   | `OTEL_SERVICE_NAME`           | `campus-api`    | `world`      |
   | `FF_OTEL_ENABLED`             | `true`          | `true`       |
   | `FF_OTEL_METRICS_ENABLED`     | `false` staging | `true`       |

   Keep the `%20` in the headers exactly as the setup page printed it.
   campus-api leaves metrics off on staging because the SDK exports them every
   minute, which would keep the sleeping API awake; traces and logs go out
   only while requests arrive. world never sleeps, so it keeps them on.
   Production is not described in `railway.ts` yet, so its variables are set
   in Railway alone.

5. **Check it arrives.** Send a request, then in Grafana open Explore:
   - **Tempo:** search `service.name = campus-api` (or `world`). A
     campus-api trace holds the HTTP server span and the Express spans under
     it.
   - **Loki:** pick `service_name` = `campus-api`. A log line's `trace_id`
     opens its trace.
   - **Metrics:** names start `nodejs_` and `v8js_`.

## When nothing arrives

- **401 from the endpoint:** the headers are wrong. The value must keep the
  `%20` between `Basic` and the token.
- **No errors and no data:** `FF_OTEL_ENABLED` is off, or the endpoint is
  unset and the SDK is sending to `localhost:4318`, where nothing listens.
- The SDK reports export failures quietly. Set `OTEL_LOG_LEVEL=debug` for one
  deploy to see them in the logs.
