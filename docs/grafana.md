# Grafana Cloud

campus-api sends traces and Node runtime metrics to Grafana Cloud over OTLP,
straight from the app: there is no collector to run. world, and the logs of
both services, are not exported yet.

## Setting up an environment

Do this once for staging and once for production.

1. **Create the stack.** On grafana.com, add a stack in an EU region (Railway
   runs the services in Amsterdam). Name it after the environment:
   `campus-staging`, `campus-production`. If the plan allows only one stack,
   use one for both: every span carries `deployment.environment`, so the two
   can still be told apart.
2. **Create the OTLP token.** In the stack's Cloud Portal, open the
   OpenTelemetry tile, choose Configure and generate a token named
   `campus-api-<environment>`. The page prints `OTEL_EXPORTER_OTLP_ENDPOINT`
   and `OTEL_EXPORTER_OTLP_HEADERS`. The headers hold the token: treat them as
   a secret.
3. **Declare before you set.** Both variables are declared on campus-api in
   [`.railway/railway.ts`](../.railway/railway.ts). The file must be applied
   with them before any value is set: an apply that does not declare a
   variable removes it.
4. **Set the variables on campus-api** in Railway, then redeploy:

   | Variable                      | Staging                     | Production                  |
   | ----------------------------- | --------------------------- | --------------------------- |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | from step 2                 | from step 2                 |
   | `OTEL_EXPORTER_OTLP_HEADERS`  | from step 2, `%20` included | from step 2, `%20` included |
   | `FF_OTEL_ENABLED`             | `true`                      | `true`                      |
   | `FF_OTEL_METRICS_ENABLED`     | `false`                     | `true`                      |

   Staging leaves metrics off because the SDK exports them every minute,
   which would keep the sleeping API awake. Traces are sent only while
   requests arrive, so they do not. Production is not described in
   `railway.ts` yet, so its variables are set in Railway alone.

5. **Check it arrives.** Send a request, then in Grafana open Explore with the
   Tempo data source and search for `service.name = campus-api`. A trace
   holds the HTTP server span and the Express spans under it. In production,
   Node runtime metrics appear under names starting `nodejs_` and `v8js_`.

## When nothing arrives

- **401 from the endpoint:** the headers are wrong. The value must keep the
  `%20` between `Basic` and the token, exactly as the setup page printed it.
- **No errors and no data:** `FF_OTEL_ENABLED` is off, or the endpoint is
  unset and the SDK is sending to `localhost:4318`, where nothing listens.
- The SDK reports export failures quietly. Set `OTEL_LOG_LEVEL=debug` for one
  deploy to see them in the logs.
