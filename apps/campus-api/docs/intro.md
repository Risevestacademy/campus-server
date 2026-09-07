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

Endpoints that require a caller identity expect a JSON Web Token (JWT) sent as:

```
Authorization: Bearer <token>
```

In the Scalar UI, use the **Authorize** button to paste a token and it will be
added to every request automatically.

## Resources

The API is organized by resource, and each resource appears as its own section
in the docs:

| Resource                | Description                          |
| ----------------------- | ------------------------------------ |
| `health`                | Service health and performance data (`GET /v1/health`) |
| `cohorts`               | Cohort management                    |
| `spaces`                | Physical spaces and occupancy        |

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

  | Code                | HTTP status | Meaning                        |
  | ------------------- | ----------- | ------------------------------ |
  | `INVALID_ARGUMENT`  | 400         | Malformed input / validation   |
  | `UNAUTHORIZED`      | 401         | Missing or invalid credentials |
  | `FORBIDDEN`         | 403         | Authenticated but not allowed  |
  | `NOT_FOUND`         | 404         | The resource does not exist    |
  | `CONFLICT`          | 409         | State conflict (e.g. duplicate)|
  | `SPACE_AT_CAPACITY` | 409         | The space is at capacity       |
  | `RATE_LIMITED`      | 429         | Too many requests, retry later |
  | `INTERNAL_ERROR`    | 500         | Unexpected server error        |

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

| Parameter  | Type   | Default | Description                    |
| ---------- | ------ | ------- | ------------------------------ |
| `page`     | number | `1`     | Page to fetch (1-based).       |
| `perPage`  | number | `20`    | Number of items per page.      |

`page` must be at least 1 and `perPage` is capped at 100.

## Client checklist

1. Always check `error.code` (never an HTTP status alone) to classify failures.
2. On `INVALID_ARGUMENT`, map `details.fields` to per-field form errors.
3. Never expect a `message` field on success.
4. Handle `429`-style resilience (retries/backoff) if your client is high volume.
5. For lists, respect `meta.totalPages` and paging params instead of assuming a
   response size.