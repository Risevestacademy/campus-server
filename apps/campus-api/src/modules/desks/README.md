# Desks

A desk is a spot inside a space, drawn on the published map and kept here by
key; where it stands stays with the map. The map sync creates and retires the
rows. The routes live under `/v1/cohorts/{cohortId}/desks`.

## Decisions

- **Claims are per cohort.** Each cohort has its own holder for a desk, and a
  person holds at most one desk in each cohort they are in. Both are partial
  unique indexes on open claims.
- **Who may claim.** Any admin, with or without a place in the cohort, and any
  live member but a guest. There is no foreign key to `cohort_members`, since
  an admin may hold a desk with no membership; the route checks instead.
- **Claiming a second desk moves you.** The first claim ends as `released` in
  the same transaction.
- **Who may let go.** The holder, as `released`. An admin may free somebody
  else's, as `freed_by_admin`, which writes `desk_freed` to the audit log.
- **A claim ends with what it hangs on.** Ending a membership ends the
  person's claim in that cohort (`enrolment_ended`); a desk leaving its map
  ends every claim on it (`desk_retired`); suspending an account ends all its
  claims (`account_suspended`); an admin made a plain user loses the claims
  they held with no live place in the cohort but as a guest
  (`admin_role_removed`). Lifting a suspension or restoring the role gives
  nothing back.
- **Role and status come from the account.** A claim reads them from `users`,
  not from the session, which can lag a demotion or a suspension.
- **Seeing desks.** Live members, guests included, and admins list a cohort's
  desks and holders. Clients fetch the list, and fetch it again when world
  sends `desksChanged`: every change notifies `desks_changed` with the cohort
  id, or empty for a sync, which touches every cohort.

## Concurrency

- A claim reads the desk under a share lock, and the map sync takes it for
  update, so a desk is never claimed after the sync retired it.
- A claim reads the account, and a member's claim their membership, under
  share locks. Suspending, demoting and ending a membership take those rows
  for update, so a claim never outlives any of them ending while it ran.
- Two claims racing for one desk, or one person's two claims racing each
  other, meet on the unique indexes; the loser gets a 409.
- A release is stamped `greatest(claimed_at, now)` through `endDeskClaims`:
  `claimed_at` is the database's clock and `now` the server's.

`desks.service.pg.spec.ts` holds each race open on a real Postgres and checks
the outcome.
