# Audit log

A record of who changed what: the admin setup (cohorts, tracks, invites) and
the changes to people's access that follow from it. One table, `audit_log`,
written by one function, `writeAuditEntry`.

It answers "who did this, and when" after the fact. It is not an event bus,
not analytics (PostHog does that), and not the request log (pino does that;
an entry's `correlationId` leads to it).

- [How an entry is written](#how-an-entry-is-written)
- [Fields](#fields)
- [Actions](#actions)
- [Personal data](#personal-data)
- [Retention](#retention)
  - [Deleting an account](#deleting-an-account)
- [Rollout](#rollout)
- [Adding an action](#adding-an-action)

## How an entry is written

```ts
await this.db.transaction(async (tx) => {
  const [row] = await tx.insert(tracks).values(/* … */).returning();
  await writeAuditEntry(tx, {
    actorUserId: admin.id,
    correlationId,
    action: AuditAction.TrackCreated,
    subject: { type: AuditSubjectType.Track, id: row.id },
    details: { name: row.name, code: row.code },
  });
});
```

Two rules, both carried by the code:

- **Same transaction as the change.** `writeAuditEntry` takes the caller's
  transaction, so the entry commits or rolls back with the change it
  describes. A refused or failed change leaves no entry, and a committed one
  is never missing its entry.
- **The action decides the shape.** `AuditEntry` is a union discriminated by
  `action`. Each action has one subject type and one set of details, declared
  in `AuditEntryShapes` in [`audit-log.ts`](./audit-log.ts). The wrong subject
  for an action, a detail left out, or one that is not part of the shape does
  not compile. An update entry's `changes` are typed field by field, so a
  `from` or `to` of the wrong type for its field does not compile either.

The payload types are this module's own. They are written out in
`audit-log.ts`, not picked off the cohorts, tracks or invites row types, so
the modules that write entries depend on this one and it does not depend back
on them. A role or a status is therefore a `string` here: those vocabularies
belong to their own modules, and the log records the value it is given. The
one import that remains is the `users` table in `schema.ts`, which the
`actor_user_id` foreign key needs.

There is no Nest module and nothing to inject: `writeAuditEntry` is a plain
function, called by the service that makes the change.

Entries are append-only, and the database enforces it. A trigger on
`audit_log` (`audit_log_append_only`, migration `0008`) rejects every row
`UPDATE` and `DELETE`, for every role including the table's owner. The only
thing a row can do is be inserted.

`TRUNCATE` is not covered: it is not a row operation and needs ownership of
the table. The test suites use it to reset between tests.

## Fields

| Column           | Meaning                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | The entry's own id.                                                                                                                                                                       |
| `actor_user_id`  | The account that did it. Null when no person did: the seed, a migration, a sweep. A foreign key to `users`.                                                                               |
| `action`         | What happened: one of `AuditAction`. A `varchar`, not a Postgres enum, so a new action is a code change and not a migration.                                                              |
| `subject_type`   | The kind of thing it happened to: one of `AuditSubjectType`.                                                                                                                              |
| `subject_id`     | That thing's id. Not a foreign key, on purpose: an entry outlives the row it is about, which is the point of recording a delete.                                                          |
| `space_id`       | Reserved for entries about a space. Nothing writes it yet, and it has no foreign key because `spaces` does not exist.                                                                     |
| `details`        | What the action needs beyond its subject, as JSON. The shape is fixed per action (see [Actions](#actions)). Dates are stored as ISO 8601 strings.                                         |
| `correlation_id` | The request's correlation id, so an entry leads to its log lines. The same value as the log lines and the `x-correlation-id` response header. Null for entries written outside a request. |
| `created_at`     | When the entry was written, which is when the change committed.                                                                                                                           |

The actor is whoever made the request, which is not always an admin: for
`membership_revived`, `system_role_changed` and `invite_flagged` it is the
invitee.

`correlation_id` is the caller's `x-correlation-id` when they sent one of up
to 64 characters, and a generated UUID otherwise. That is decided once, as
the request arrives (`resolveCorrelationId` in `shared/http`), so the entry
never holds a shortened or different id from the one in the logs. It is
still caller-supplied text: treat it as a pointer to logs and never as proof
of anything.

Indexes cover the three ways the table is read: by time (`created_at`), by
actor (`actor_user_id, created_at`) and by subject
(`subject_type, subject_id, created_at`).

## Actions

| Action                  | Subject         | Actor              | `details`                                                                                                                                                       | Written when                                                                                    |
| ----------------------- | --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `cohort_created`        | `cohort`        | admin              | `name`, `code`, `status`, `startDate`, `endDate`                                                                                                                | A cohort is created.                                                                            |
| `cohort_updated`        | `cohort`        | admin              | `changes`: each field that moved, with `from` and `to`                                                                                                          | A cohort edit changes at least one field. An edit that moves nothing writes no entry.           |
| `cohort_deleted`        | `cohort`        | admin              | The cohort as it was: `name`, `code`, `status`, `startDate`, `endDate`                                                                                          | A cohort is deleted. The row is gone, so this is the only trace of it.                          |
| `cohort_track_attached` | `cohort_track`  | admin              | `cohortId`, `trackId`                                                                                                                                           | A track is attached to a cohort.                                                                |
| `cohort_track_detached` | `cohort_track`  | admin              | `cohortId`, `trackId`                                                                                                                                           | A track is detached from a cohort. The link row is gone, so this is the only trace of it.       |
| `track_created`         | `track`         | admin              | `name`, `code`                                                                                                                                                  | A track is created.                                                                             |
| `track_updated`         | `track`         | admin              | `changes`: each field that moved, with `from` and `to`                                                                                                          | A track edit changes at least one field.                                                        |
| `track_deleted`         | `track`         | admin              | The track as it was: `name`, `code`, `description`                                                                                                              | A track is deleted.                                                                             |
| `invite_created`        | `invite`        | admin              | `cohortId`, `cohortRole`, `cohortTrackId`, `systemRole`, `expiresAt`, `guestAccessExpiresAt`                                                                    | An invite is created.                                                                           |
| `invite_revoked`        | `invite`        | admin              | `cohortId`, `expiresAt`                                                                                                                                         | An admin revokes a pending invite.                                                              |
| `invite_flagged`        | `invite`        | invitee            | `cohortId`, `invitedBy`                                                                                                                                         | The invitee flags a mistake on their invite.                                                    |
| `invite_resent`         | `invite`        | admin              | `cohortId`, `expiresAt` (the new deadline), `previousExpiresAt`                                                                                                 | An admin resends an invite: a new link for a live one, or an expired one brought back.          |
| `membership_revived`    | `cohort_member` | invitee            | `inviteId`, `invitedBy`, `previous`: the membership as it stood (`role`, `cohortTrackId`, `status`, `dismissalReason`, `joinedAt`, `leftAt`, `accessExpiresAt`) | Accepting an invite brings back a membership that had ended. A first enrolment writes no entry. |
| `guest_visit_extended`  | `cohort_member` | admin              | `cohortId`, `accessExpiresAt` (the new deadline), `previousAccessExpiresAt`                                                                                     | An admin moves a guest's visit end forward. A visit that has already ended is refused instead.  |
| `system_role_changed`   | `user`          | invitee, or nobody | `from`, `to`, and either `inviteId` + `invitedBy` (an accepted invite granted it) or `source: "seed"`                                                           | An account becomes an admin. Nothing is written if it already was one.                          |

What is not recorded, so nobody goes looking for it:

- Accepting or declining an invite, unless the accept revives a membership
  or grants admin. The invite row itself holds its status and `accepted_at`.
- A first enrolment into a cohort.
- An invite lapsing. Nobody does that; the status flips when something reads
  it.
- Sign-ins, sign-outs and token refreshes.
- Reads of any kind.

## Personal data

The log is about people's access, so it refers to people. The rule is that
it refers to them by id and holds as little else as it can.

**Recorded**

- User ids: the actor, and `invitedBy` in details.
- Ids of invites, cohorts, tracks and memberships.
- Roles, statuses and dates.
- Cohort and track names, codes and descriptions. These describe the
  programme, not a person.

**Never recorded**

- Email addresses. An invite entry carries the invite's id; the address
  stays on the invite.
- Names of people.
- Invite tokens or their hashes.
- What an invitee wrote when flagging an invite. It stays on the invite
  (`flag_message`).
- Anything from a request body that is not listed in the action's shape.

**The one exception**

`membership_revived` keeps `previous.dismissalReason`. It is free text an
admin wrote about a named person, and it is the most sensitive thing in the
table. It is here because reviving a membership clears the reason from
`cohort_members`, and without the entry the fact that somebody was dismissed,
and why, would be gone. Treat any export or screen built on this table
accordingly.

An id is still personal data while the `users` row it points to exists, so
access to this table should be as narrow as access to `users`. No API route
reads it today; it is reachable only with database access.

## Retention

**How long entries are kept is not decided.** They are kept indefinitely:
nothing deletes or archives them, and there is no sweep job. Before real
members' data accumulates here, someone needs to decide a retention period.

Whatever is decided has to work with the trigger: entries cannot be deleted
by an ordinary query. A retention sweep would be a deliberate, reviewed
operation that lifts the trigger for its own transaction
(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`).

### Deleting an account

Decided: **an account that has to go is stripped, not removed, and the audit
log is not touched.**

The `users` row stays, so the entries it wrote still have an actor to point
to. Its personal fields are wiped — the address, names, avatar, phone, bio
and Google identity — and it is marked as deleted so it cannot sign in. What
remains in the log is an id that no longer leads to a person.

This is forced as much as chosen. `actor_user_id` is a foreign key to
`users` with no `ON DELETE` action, so removing the row of somebody who has
acted fails while their entries exist, and the trigger means those entries
can be neither removed nor have their actor nulled.

Not built yet: there is no route or script that does the stripping, and
`users` has no deleted state. Until there is, do not hard-delete a `users`
row by hand.

Two things the stripping has to cover when it is built:

- `membership_revived` entries about the person keep
  `previous.dismissalReason`, free text that may identify them. It lives in
  the log, so stripping the `users` row does not reach it.
- A user who is only the _subject_ of entries (`subject_id`, or `invitedBy`
  inside `details`) is referenced by id with no foreign key. Those entries
  keep the id either way.

## Rollout

- **Migrations.** `0006_audit_log` creates the table and its indexes.
  `0008_audit_log_append_only` adds the trigger that refuses updates and
  deletes. Both are additive and touch no other table. There is no feature
  flag and no environment variable.
- **Order.** Migrate before seeding. The seed writes a
  `system_role_changed` entry when it creates or promotes an admin, so it
  fails without the table. The deploy command already runs `db:migrate` then
  `db:seed`.
- **No backfill.** History starts when the migration is applied. Cohorts,
  tracks, invites and admins that existed before it have no entries, and an
  empty history for a subject does not mean nothing happened to it.
- **Old code, new table.** A release that predates this module simply does
  not write entries. Rolling back the code does not need the migration
  rolled back.
- **Reading it.** There is no API or admin screen yet. Query it directly,
  for example everything that happened to one invite:

  ```sql
  select created_at, action, actor_user_id, details
  from audit_log
  where subject_type = 'invite' and subject_id = '<invite id>'
  order by created_at;
  ```

## Adding an action

1. Add it to `AuditAction` in [`schema.ts`](./schema.ts), with a comment on
   what it means. Add a subject type to `AuditSubjectType` if it needs a new
   one.
2. Give it a shape in `AuditEntryShapes` in [`audit-log.ts`](./audit-log.ts).
   The build fails until you do.
3. Call `writeAuditEntry` inside the transaction that makes the change.
4. Check the details against [Personal data](#personal-data): ids, not
   addresses or names.
5. Add a row to the [Actions](#actions) table.
6. Test it against PGlite: that the entry is written with the change, and
   that a refused change writes none.
