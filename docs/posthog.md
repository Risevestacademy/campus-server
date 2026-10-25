# PostHog

campus-api and world send errors to PostHog Error Tracking. Neither sends
product events yet.

## What is reported

Every `error` or `fatal` log line that carries an error (`err`, or an `Error`
logged on its own) is reported. A `warn` line never is. So the log level
decides: `error` means somebody has to look, `warn` means it was handled.

- campus-api's exception filters log every 5xx at `error`, so every 5xx is
  reported, including those thrown by guards. 4xx responses are not.
- A `SERVICE_UNAVAILABLE` 503 is reported at the `warning` level, so it
  groups apart from bugs.
- Uncaught exceptions are reported before the process exits, once the
  reporter exists. In campus-api it is built with the Nest app, so a crash
  before that, such as invalid configuration, is only in the logs. world
  builds it first, when the app is built.

Each report carries the service (`OTEL_SERVICE_NAME`: `campus-api` or
`world`, the same name its traces and logs carry in Grafana, so keep those
names; changing one splits that service's history in both), the environment
and the release (the deployed commit, from `RAILWAY_GIT_COMMIT_SHA`), and, where the log line has them, the
person's `users.id`, the message, the correlation id, the method, the route
template, the status code and the trace id: the fields `LoggedErrorFields`
names. Nothing else from the log line goes, since it can hold personal data.
No IP address is sent.

The exception itself goes with its type, message and stack. A failed
query's message can carry the values it was given (drizzle appends them as
`params:`, and Postgres quotes the value it rejected), so those keep only the
statement and the SQLSTATE, causes included. Log lines and world's spans get
the same scrub, since they leave for Grafana. Any other message is sent as
written: **an error's message must not carry personal data**. Put an id in
it, not an email or a name.

On shutdown the reporter has 3 seconds to send what it holds.

The shared code is in [`packages/error-reporting`](../packages/error-reporting):
the reporter, the pino hooks both apps install with `reportingHooks`, and
`LOG_REDACT_PATHS`, the one list of fields both apps redact from their logs.

## Configuration

Both services read the same three variables, validated at boot:

- `FF_POSTHOG_ENABLED`: off by default.
- `POSTHOG_PROJECT_TOKEN`: required when on, and must start with `phc_`.
- `POSTHOG_HOST`: HTTPS, `https://eu.i.posthog.com` by default.

Use one PostHog project per environment, the same one for both services.

## How to verify it works

1. Trigger a 500 → it shows up in PostHog Error Tracking with its route and
   correlation id. The id matches the response's `x-correlation-id` header
   and the request's log lines.
2. Trigger a 4xx → nothing is reported.
3. Enable the flag with a missing or malformed token → the service fails to
   boot with a clear error, not a silent no-op.
