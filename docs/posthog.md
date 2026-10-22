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
- Uncaught exceptions are reported before the process exits.

Each report carries the service, environment and release (the deployed
commit, from `RAILWAY_GIT_COMMIT_SHA`), and, where the log line has them, the
person's `users.id`, the correlation id, the method, the route template, the
status code and the trace id. Nothing else from the log line goes, since it
can hold personal data. No IP address is sent.

The shared code is in [`packages/error-reporting`](../packages/error-reporting).
Each app wires it into its logger with a pino `logMethod` hook.

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
