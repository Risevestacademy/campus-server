# Campus API — Integration Guide

This document is the starting point for anyone integrating with the Campus
API. It explains the base endpoints, authentication, and the two response
shapes you will encounter: the success documents and the single error contract.

## Base URL

```
http://localhost:3000/v1
```

All API endpoints are served under the `/v1` prefix; new major versions will get
a new prefix (`/v2`, ...) instead of breaking existing clients.

Interactive documentation (Scalar UI) is served at `http://localhost:3000/docs`.
The raw OpenAPI document (JSON) is served at `http://localhost:3000/docs-json`.

## Rate limiting

The API is rate-limited per IP to **100 requests per 60 seconds**. When the
limit is exceeded you get a `429` response with the `RATE_LIMITED` code (see
[The one error contract](#the-one-error-contract)). Clients should slow down and
back off rather than retrying immediately.

## Authentication

A browser never holds a token. The API sets the session in **httpOnly
cookies** and reads them back itself, so the web app's only job is to send
every request with credentials:

```ts
fetch(`${API}/v1/auth/me`, { credentials: 'include' });
```

In campus-web, `API` is `/api`: its own proxy forwards `/api/*` here, so the
browser only ever talks to the frontend's host. The whole invitee journey,
screen by screen, is in `docs/invite-to-campus.md`.

API clients and the Scalar UI can send the same token as a header instead:

```
Authorization: Bearer <token>
```

A native app works this way throughout, and gets its tokens in response
bodies rather than cookies: see [Native apps](#native-apps).

In the Scalar UI, use the **Authorize** button to paste a token and it will be
added to every request automatically.

### Signing in

Registration is invite-only and there is no password anywhere in the system.
The API owns the whole OAuth exchange, so a client never talks to Google
itself:

1. Send the browser to `GET /v1/auth/google` as a **top-level navigation** —
   not `fetch`, which cannot follow a cross-origin redirect and will not keep
   the cookie the next step needs.
2. The user picks an account at Google, which returns them to
   `GET /v1/auth/google/callback`.
3. The API verifies the request, resolves the account behind the Google
   identity, sets the session cookies, and redirects back into the web app.

Every outcome of step 3 is a redirect to the web app (`APP_PUBLIC_URL`):

| Redirect                | Meaning                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/campus`               | On the roster (an admin, or an active cohort member). Full access.                                                   |
| `/invitation`           | Holds an invite they have not answered. Provisional session — or full access for a member invited to another cohort. |
| `/sign-in?error=<code>` | Refused. Nothing was signed in.                                                                                      |

The web app needs a `/sign-in` page that reads `error` and explains it:

| `error`                                                 | What happened                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `invite_required`                                       | Nobody invited this Google account's address. The usual cause is signing in with a different account from the one the invite went to.   |
| `account_suspended`                                     | The account exists but has been closed.                                                                                                 |
| `denied`                                                | The user cancelled at Google.                                                                                                           |
| `expired_state`                                         | The sign-in took longer than 10 minutes. Start again.                                                                                   |
| `invalid_state`                                         | The callback could not be matched to a sign-in this browser started, for example because it was opened in another browser. Start again. |
| `unverified_email`                                      | The Google account has no verified address.                                                                                             |
| `missing_code`, `exchange_failed`, `incomplete_profile` | Google did not complete the exchange. Start again.                                                                                      |
| `invalid_request`                                       | The callback URL was malformed.                                                                                                         |
| `rate_limited`                                          | Too many attempts. Wait a minute.                                                                                                       |
| `server_error`                                          | Something failed on our side.                                                                                                           |

The invite link (`/invitation?token=…`) opens the web app's invitation
screen. Before anyone signs in, `POST /v1/invites/preview` with `{ "token" }`
returns what to show — cohort, track, role, who sent it, and the address it
went to — or says the invite is expired, taken or revoked. Sign-in itself
matches the invite by email address, so the token plays no part in step 1:
show the address, then send the user through it.

### Who is signed in

`GET /v1/auth/me` answers for either kind of session, so call it when the web
app loads:

```json
{
  "scope": "full_access",
  "expiresAt": "2026-09-30T12:15:00.000Z",
  "inviteId": null,
  "user": {
    "id": "…",
    "email": "ada@campus.local",
    "displayName": "Ada Lovelace",
    "systemRole": "user",
    "…": "…"
  },
  "membership": { "cohortId": "…", "role": "student" },
  "memberships": [
    {
      "cohortId": "…",
      "role": "student",
      "cohort": { "name": "Cohort 3", "code": "C3" }
    },
    {
      "cohortId": "…",
      "role": "mentor",
      "cohort": { "name": "Cohort 2", "code": "C2" }
    }
  ]
}
```

- `inviteId` set → an invite to answer, whatever the scope (a member can be
  invited to another cohort). Load it with
  `GET /v1/invites/validate-user-invite`.
- `scope: "full_access"` → the campus. A person can belong to several
  cohorts, in any mix of roles: `memberships` lists every one they may enter,
  most recently joined first, for the cohort picker. `membership` is only
  the first of them, kept for older clients.
- `scope: "provisional"` → onboarding. Load the invite with
  `GET /v1/invites/validate-user-invite`, then answer it with
  `POST /v1/invites/decision`. Accepting upgrades the cookies to full access
  in the same response; declining clears them.
- `401` → nobody is signed in (after trying a refresh, below).

### Staying signed in

A full-access session is two cookies: a short access token (15 minutes by
default) and a refresh token (30 days).

**Refresh ahead of time.** `POST /v1/auth/refresh`, with credentials, rotates
both cookies and says when the new ones lapse:

```json
{
  "expiresAt": "2026-09-30T12:15:00.000Z",
  "refreshExpiresAt": "2026-10-30T12:00:00.000Z"
}
```

Schedule the next refresh a minute before `expiresAt`. Take the first
deadline from `GET /v1/auth/me`, which carries `expiresAt` too — sign-in and
accepting an invite are redirects and cookie changes, with no body to read it
from. Don't assume 15 minutes: a guest's token ends with their visit, which
can be sooner. Refreshing ahead matters most in the world, which closes a
socket whose sign-in has stopped being refreshed even while the user is
making no other calls.

**And on a 401 anyway** (a laptop waking from sleep, say):

1. Call `POST /v1/auth/refresh` once.
2. If it succeeds, retry the original call. If it answers `401` too, send the
   user to sign in.

Share one in-flight refresh across the scheduled one and any 401s rather
than starting one per caller. The API tolerates a brief overlap between tabs,
but a refresh token replayed after that window ends the whole session.

A provisional session has no refresh token. Someone who takes longer than 30
minutes over onboarding signs in again, and lands back on `/invitation`.

### Signing out

`POST /v1/auth/logout`, with credentials. It revokes the refresh token and
clears both cookies. It answers `204` even when nobody was signed in.

### Native apps

A native app has no cookie jar to rely on, so it holds its own tokens. Every
route behaves the same; only how the session travels differs.

**Sign in.** Run Google sign-in with Google's SDK on the device, then post the
`idToken` it returns:

```
POST /v1/auth/google/token
{ "idToken": "<id_token from the Google SDK>" }
```

```json
{
  "scope": "full_access",
  "accessToken": "…",
  "expiresAt": "2026-09-30T12:15:00.000Z",
  "refreshToken": "…",
  "refreshExpiresAt": "2026-10-30T12:00:00.000Z",
  "inviteId": null
}
```

The decision is the one the browser callback makes, answered as JSON instead
of a redirect:

| Answer                        | Meaning                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`, `scope: "full_access"` | On the roster. `inviteId` set means an invite to another cohort is waiting.                                                                                                                |
| `200`, `scope: "provisional"` | Holds an invite to answer (`inviteId`). No refresh token: `refreshToken` and `refreshExpiresAt` are null.                                                                                  |
| `403 INVITE_REQUIRED`         | Nobody invited this Google account's address.                                                                                                                                              |
| `403 ACCOUNT_SUSPENDED`       | The account exists but has been closed.                                                                                                                                                    |
| `401 UNAUTHORIZED`            | The id_token was not accepted. `details.reason` is `exchange_failed` (not verifiable, or addressed to a client this deployment does not name), `unverified_email` or `incomplete_profile`. |

The id_token must be addressed to a Google client this deployment names:
its web client, or a native client listed in `GOOGLE_MOBILE_CLIENT_IDS`.

**Call the API.** Send `Authorization: Bearer <accessToken>` on every
request, and on the `world` socket upgrade.

**Stay signed in.** `POST /v1/auth/refresh` with
`{ "refreshToken": "…" }` answers with a new pair:

```json
{
  "accessToken": "…",
  "expiresAt": "2026-09-30T12:30:00.000Z",
  "refreshToken": "…",
  "refreshExpiresAt": "2026-10-30T12:15:00.000Z"
}
```

Store both, replacing the old ones: a refresh token works once. The timing
rules above apply unchanged — refresh ahead of `expiresAt`, share one
in-flight refresh, and treat a `401` from refresh as signed out.

**Answer an invite.** `POST /v1/invites/decision` with the bearer token. When
an accept upgrades a provisional session, the response carries the new
full-access tokens in `session`, in the same shape as sign-in without
`inviteId`. Replace the provisional token with them.

**Sign out.** `POST /v1/auth/logout` with `{ "refreshToken": "…" }`, then
discard both tokens.

Keep the tokens in the platform's secure storage (Keychain, Keystore), never
in plain preferences.

## Resources

The API is organized by resource, and each resource appears as its own section
in the docs:

| Resource  | Description                                            |
| --------- | ------------------------------------------------------ |
| `auth`    | Google sign-in (`GET /v1/auth/google`)                 |
| `health`  | Service health and performance data (`GET /v1/health`) |
| `cohorts` | Cohort management                                      |
| `users`   | The admin's list of accounts, with filters             |
| `profile` | A member's own profile, and other members' cards       |
| `spaces`  | Physical spaces and occupancy                          |

Each operation documents its path, expected request body/query parameters, and
every possible response (including each error status) inline.

## Success responses

Success responses are the data itself — there is no `message` wrapper and no
envelope. A `GET /v1/health` call returns the health document directly; a resource
endpoint returns its resource document directly. What you see in the docs is
exactly what the endpoint returns.

## The one error contract

Every error response in the API shares a single envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found",
    "details": {
      "field": "value"
    }
  }
}
```

- **`code`** — machine-readable, always one of the values below:

  | Code                      | HTTP status | Meaning                          |
  | ------------------------- | ----------- | -------------------------------- |
  | `INVALID_ARGUMENT`        | 400         | Malformed input / validation     |
  | `UNAUTHORIZED`            | 401         | Missing or invalid credentials   |
  | `FORBIDDEN`               | 403         | Authenticated but not allowed    |
  | `NOT_FOUND`               | 404         | The resource does not exist      |
  | `CONFLICT`                | 409         | State conflict (e.g. duplicate)  |
  | `SPACE_AT_CAPACITY`       | 409         | The space is at capacity         |
  | `INVITE_ALREADY_ACCEPTED` | 409         | The invite was already accepted  |
  | `INVITE_ALREADY_DECLINED` | 409         | The invite was already declined  |
  | `INVITE_REVOKED`          | 409         | An admin revoked the invite      |
  | `INVITE_REQUIRED`         | 403         | No invite for this address       |
  | `INVITE_EXPIRED`          | 403         | The invite has expired           |
  | `ACCOUNT_SUSPENDED`       | 403         | The account exists but is closed |
  | `RATE_LIMITED`            | 429         | Too many requests, retry later   |
  | `INTERNAL_ERROR`          | 500         | Unexpected server error          |

- **`message`** — a human-readable description, safe to show to end users.
- **`details`** — optional structured context specific to the error.

### Validation errors

When request data fails validation, you get `INVALID_ARGUMENT` with a `fields`
map that tells you exactly which field failed and why:

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Request validation failed",
    "details": {
      "fields": {
        "email": "email must be an email",
        "name": "name should not be empty"
      }
    }
  }
}
```

Nested objects use dot notation in the field name (for example
`address.city`). 400 is the only status where you should parse `details.fields`
to drive per-field UI errors; other codes use `details` for extra context.

## Paginated endpoints

Endpoints that return a list of resources respond with a paginated document:

```json
{
  "items": [],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 152,
    "totalPages": 8
  }
}
```

- `items` — the page of resources (one per endpoint, as documented).
- `meta.page` — current page, 1-based.
- `meta.perPage` — page size used.
- `meta.total` — total number of resources across all pages.
- `meta.totalPages` — total number of pages.

List endpoints accept the following query parameters:

| Parameter | Type   | Default | Description               |
| --------- | ------ | ------- | ------------------------- |
| `page`    | number | `1`     | Page to fetch (1-based).  |
| `perPage` | number | `20`    | Number of items per page. |

`page` must be at least 1 and `perPage` is capped at 100.

## Client checklist

1. Always check `error.code` (never an HTTP status alone) to classify failures.
2. On `INVALID_ARGUMENT`, map `details.fields` to per-field form errors.
3. Never expect a `message` field on success.
4. Handle `429`-style resilience (retries/backoff) if your client is high volume.
5. For lists, respect `meta.totalPages` and paging params instead of assuming a
   response size.
