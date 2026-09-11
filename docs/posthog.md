# PostHog (campus-api)

Exception tracking only — no custom product events from the backend.

## How it's set up

- Env vars: `FF_POSTHOG_ENABLED`, `POSTHOG_PROJECT_TOKEN` (must start with `phc_`),
  `POSTHOG_HOST` (must be HTTPS) — validated at boot in
  [env.ts](../apps/campus-api/src/infra/config/env.ts). Disabled by default;
  set per Railway environment only.
- Reporting is handled by PostHog's own `PostHogInterceptor`
  (`posthog-node/nestjs`), registered in
  [main.ts](../apps/campus-api/src/main.ts) . Only captures
  responses ≥ 500 (4xx is expected traffic, not a bug), with method, path,
  status code, IP, and user agent attached automatically.

## Frontend correlation

Reads the `X-PostHog-Distinct-Id` header (PostHog's own standard header) to
attribute an exception to a user. **The frontend doesn't send this yet** —
until it does, backend exceptions show with no linked person.

`POSTHOG_HOST` must match whichever region (EU/US) the frontend's PostHog
project actually uses — they're separate infrastructures, and a mismatch
means the backend silently reports into a project no one is looking at.

## How to verify it works

1. Trigger a 500 → shows up in PostHog Error Tracking.
2. Trigger a 4xx → nothing captured.
3. Enable the flag with a missing/malformed key → app fails to boot with a
   clear error, not a silent no-op.
