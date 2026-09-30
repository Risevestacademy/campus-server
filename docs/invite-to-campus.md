# From invite to campus

What happens from the moment someone is invited to the moment they are
standing in their cohort's campus: each screen in campus-web, and each call
it makes to campus-api. Browser calls go through campus-web's proxy, so
`/api/v1/...` in the browser is `/v1/...` on campus-api — see
[deployment.md](./deployment.md#domains-and-cookies).

The mechanics behind each step (state, sessions, refresh) are in
[auth-flow.md](./auth-flow.md). This page is the journey.

## At a glance

| #   | Where                     | What the invitee sees                                                                    | Call                                                                                 |
| --- | ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Admin                     | —                                                                                        | `POST /v1/invites` returns `inviteLink`                                              |
| 2   | Inbox                     | An email with the link (sent by the admin for now — see [Not built yet](#not-built-yet)) | —                                                                                    |
| 3   | `/invitation?token=…`     | The invite: cohort, track, role, who invited them, Continue with Google                  | `GET /api/v1/auth/me` → 401, then `POST /api/v1/invites/preview`                     |
| 4   | Google                    | Account picker                                                                           | top-level navigation to `/api/v1/auth/google`                                        |
| 5   | `/invitation`             | Back from Google, signed in                                                              | `GET /api/v1/auth/me` → provisional, then `GET /api/v1/invites/validate-user-invite` |
| 6   | `/preview`                | "Are your details correct?"                                                              | none — reuses step 5's answer                                                        |
| 7   | Go to Campus              | —                                                                                        | `POST /api/v1/invites/decision` `{ "decision": "accept" }`                           |
| 8   | `/campus/{cohortId}/join` | Their cohort's campus                                                                    | `GET /api/v1/auth/me` → full access                                                  |

## The whole journey

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    actor I as Invitee
    participant W as campus-web
    participant A as campus-api
    participant G as Google

    Admin->>A: POST /v1/invites { email, cohortId, cohortRole, cohortTrackId }
    A-->>Admin: inviteLink = APP_PUBLIC_URL/invitation?token=…
    Admin-->>I: email with the link

    I->>W: open /invitation?token=…
    W->>A: GET /v1/auth/me
    A-->>W: 401 — nobody signed in
    W->>A: POST /v1/invites/preview { token }
    A-->>W: cohort, track, role, invitedBy, email
    W-->>I: the invite + Continue with Google (as email)

    I->>A: navigate to /api/v1/auth/google
    A-->>I: 302 to Google + state cookie
    I->>G: pick the invited account
    G-->>I: 302 to /api/v1/auth/google/callback
    I->>A: callback
    A->>A: match the Google address to a live invite
    A-->>I: 302 to /invitation + provisional session cookie

    I->>W: /invitation
    W->>A: GET /v1/auth/me
    A-->>W: scope provisional, inviteId
    W->>A: GET /v1/invites/validate-user-invite
    A-->>W: cohort, track, role, invitedBy, user
    W-->>I: the invite + Continue

    I->>W: /preview — name, email, role, cohort
    I->>W: Go to Campus
    W->>A: POST /v1/invites/decision { accept }
    A->>A: create the membership, fill the profile
    A-->>W: 200 membership.cohortId + full-access and refresh cookies
    W-->>I: /campus/{cohortId}/join
```

## Screen by screen

### 1–2. The invite and the email

An admin creates the invite with `POST /v1/invites`. The response carries
`inviteLink` — `APP_PUBLIC_URL/invitation?token=<raw>` — exactly once; only
its hash is stored. The invite stays open for `INVITE_TTL_DAYS` (7) unless
the admin sets `expiresAt`.

Nothing sends that link today. The admin copies it into an email themselves.

### 3. `/invitation`, signed out

On load, `GET /api/v1/auth/me`. A 401 means nobody is signed in, so read the
invite from the link instead — no session needed, the token is the proof:

```ts
fetch('/api/v1/invites/preview', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
```

It is a POST so the token stays out of URLs, which get logged. Render:

| On screen                | From the response                                             |
| ------------------------ | ------------------------------------------------------------- |
| Cohort                   | `cohort.name`                                                 |
| Track                    | `track.name`                                                  |
| Role                     | `cohortRole` (`null` for an admin invite — show `systemRole`) |
| Invited by               | `invitedBy.firstName` `invitedBy.lastName`                    |
| Visit ends (guests only) | `guestAccessExpiresAt`                                        |

Then one action, **Continue with Google**, a top-level navigation
(`window.location.href = '/api/v1/auth/google'`), never `fetch`. Show
`email` beside it: sign-in matches the invite by address, and picking another
Google account is the most common way to end up at
`/sign-in?error=invite_required`.

When the preview refuses, say why instead of offering Google:

| Answer                                           | Say                                                    |
| ------------------------------------------------ | ------------------------------------------------------ |
| 404 `NOT_FOUND`                                  | The link is incomplete — copy it again from the email. |
| 403 `FORBIDDEN`                                  | The invite has expired; ask for a new one.             |
| 409 `INVITE_ALREADY_ACCEPTED`                    | Already joined — sign in from `/sign-in`.              |
| 409 `INVITE_ALREADY_DECLINED` / `INVITE_REVOKED` | This invite is closed; ask the admin.                  |

### 4. Google

Google shows its account picker and returns to the callback. campus-api
finds a live invite for that address, creates the account (or links a
seeded one), and redirects to `/invitation` with a **provisional** session:
good for 30 minutes, and for nothing but `/v1/auth/me` and the invitation
routes.

### 5. `/invitation`, signed in

The same page, now `GET /api/v1/auth/me` answers `scope: "provisional"`.
The `?token=` is gone — Google's return trip does not carry it — so load the
invite through the session with `GET /api/v1/invites/validate-user-invite`.
It has the same cohort, track, role and invitedBy fields as the preview, plus
the signed-in account under `user`. **Continue** goes to `/preview`.

### 6. `/preview`

Name and email come from `user` in the same response (`firstName`,
`lastName`, `email` — as Google gave them); role and cohort as above. Keep
the step 5 response in memory rather than refetching.

### 7. Go to Campus

`POST /api/v1/invites/decision` with `{ "decision": "accept" }`. In one
response campus-api creates the membership, fills the profile, marks the
invite accepted, and replaces the provisional cookie with a full-access one
plus a refresh cookie. The body says where they now belong:

```json
{
  "status": "accepted",
  "membership": { "cohortId": "…", "role": "student", "…": "…" },
  "systemRole": "user"
}
```

### 8. The campus

Navigate to `/campus/{membership.cohortId}/join` — or `/campus` when
`membership` is `null`, which is an admin invite with no cohort. From here
on the invitee is a member: sessions renew with `POST /api/v1/auth/refresh`,
and next time they sign in from `/sign-in` they go straight to `/`.

## When it goes another way

| Situation                                     | What happens                                                     | What the invitee sees                                                   |
| --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Signs in with a different Google account      | No invite for that address                                       | `/sign-in?error=invite_required` — say which address the invite went to |
| Invite expired or revoked before they open it | The preview refuses                                              | `/invitation` explains it, and never sends them to Google               |
| Invite expires between sign-in and accept     | `validate-user-invite` and `decision` answer 403 `FORBIDDEN`     | Ask the admin for a new invite                                          |
| Admin revokes it between sign-in and accept   | They answer 409 `INVITE_REVOKED`                                 | Same                                                                    |
| Takes longer than 30 minutes on steps 5–7     | Provisional session lapses, `me` answers 401, no refresh         | Continue with Google again; they land back on `/invitation`             |
| Cancels at Google                             | —                                                                | `/sign-in?error=denied`                                                 |
| Opens the link again after accepting          | Sign-in finds a member, not an invite                            | Straight to `/`                                                         |
| Already signed in as a member, opens the link | `me` answers `full_access`                                       | Send them to `/campus`                                                  |
| Declines                                      | `decision` with `decline`; invite closed, session cookie cleared | Nothing left to do; the admin can invite again                          |

Every `?error=` code is listed in the API guide
(`apps/campus-api/docs/intro.md`).

## Not built yet

- **Sending the email.** campus-api returns the link to the admin and sends
  nothing. Until it does, the admin pastes the link into an email by hand.
- **Decline and "Flag an Issue".** campus-api supports declining; the
  designs have no button for it. "Flag an Issue" on `/preview` has no
  backend yet.
- **`/` in campus-web.** Returning members land on `/`, which has to send
  them on to `/campus`.
- **campus-web's proxy** still forwards only an `accessToken` cookie and
  drops `Location`, so steps 3–8 do not work through it yet. What it needs
  is listed in [deployment.md](./deployment.md#how-campus-web-reaches-the-api-its-own-proxy).
