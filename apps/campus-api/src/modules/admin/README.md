# Admin

Operations that reach across other modules' tables, for super admins only.
Today that is one: the retention sweep.

- [Retention sweep](#retention-sweep)
  - [What is kept](#what-is-kept)
  - [Calling it](#calling-it)
  - [Schedule](#schedule)
  - [How the audit log is swept](#how-the-audit-log-is-swept)
  - [Safety](#safety)

## Retention sweep

`RetentionService` deletes rows that have outlived their retention period.
It has one method per table, `sweepNotifications` and `sweepAuditLog`, each
callable on its own, and `sweep`, which runs one or both.

### What is kept

| Table           | Deleted                                      | Period (default) | Variable                      |
| --------------- | -------------------------------------------- | ---------------- | ----------------------------- |
| `notifications` | **Read** notifications older than the period | 90 days          | `NOTIFICATION_RETENTION_DAYS` |
| `audit_log`     | Entries older than the period                | 365 days         | `AUDIT_LOG_RETENTION_DAYS`    |

Unread notifications are kept at any age: a member who has not signed in for
months still finds them waiting.

"Older than the period" is by `created_at`: a row goes when it was created
before _now − period_. Refresh tokens are not part of this; they expire, and
are dealt with by the session code.

### Calling it

`POST /v1/admin/retention/sweep`, super admin only. A plain admin gets a 403.

```jsonc
// Body, every field optional
{
  "table": "notifications", // or "audit_log"; omitted, both are swept
  "retentionDays": 60, // a one-off period, only with `table`
}
```

```jsonc
// 200
{
  "swept": [
    {
      "table": "notifications",
      "deleted": 128,
      "cutoff": "2026-08-07T09:30:00.000Z",
      "retentionDays": 90,
    },
    {
      "table": "audit_log",
      "deleted": 0,
      "cutoff": "2025-11-05T09:30:00.000Z",
      "retentionDays": 365,
    },
  ],
}
```

`retentionDays` without `table` is refused. A period that suits notifications
is drastic for the audit log, so a one-off period is never applied to both.

### Schedule

**Nothing runs the sweep on a timer.** Call the route on a recurring schedule,
daily or weekly, from an external scheduler: a cron job, a Railway cron
service, or a GitHub Actions schedule, signed in as a super admin. Missing a
run does no harm: the next one deletes whatever has since come due.

The API sleeps when idle, so a timer inside it would either keep it awake or
not fire. A built-in scheduler may come later. For now an external call is
enough.

### How the audit log is swept

`audit_log` is append-only: the `audit_log_append_only` trigger (migration
`0008`) refuses every `UPDATE` and `DELETE`, for every role. The sweep lifts
it for its own transaction and for nothing else:

1. Open a transaction and set `lock_timeout` to 5 seconds.
2. `ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`.
3. Delete the entries created before the cutoff.
4. `ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`.
5. Write the sweep's own `retention_swept` entry. The trigger is already back
   on, so the entry is protected from the moment it commits.
6. Commit.

`ALTER TABLE` is transactional. If any step fails, the rollback undoes the
disable along with the delete, so the trigger is never left off. The lock
it takes (`SHARE ROW EXCLUSIVE`) blocks every other insert, update and
delete on `audit_log` until commit, and any second sweep, so nothing else
can delete while the trigger is disabled. Reads are not blocked.

That lock has a cost. While the sweep runs, every write to the audit log,
and so every admin change that records one, waits for it. The lock timeout
means a sweep queued behind a long transaction gives up quickly rather than
holding everyone else up. If one fails that way, run it again. A first sweep
after a long time without one is the slow case: run it at a quiet hour.

`ALTER TABLE` needs ownership of the table. The API must connect as the role
that ran the migrations, as it does on every environment today.

The trigger's name is `AUDIT_LOG_APPEND_ONLY_TRIGGER` in
[`audit/schema.ts`](../audit/schema.ts). Renaming the trigger means changing
it there too, or the sweep fails. It fails safely, before anything is
deleted.

### Safety

- **A 30-day floor.** No period under 30 days is accepted, from the
  environment (boot fails) or from a caller (400). Nothing younger than 30
  days is ever deleted.
- **Logged.** Each table swept logs a `retention sweep` line at info level,
  with the table, the rows deleted, the cutoff and the period.
- **Audited.** Each table swept writes a `retention_swept` entry with the
  caller as the actor, in the same transaction as the delete. See the
  [audit log's actions](../audit/README.md#actions).
- **One transaction per table.** Sweeping both runs notifications first. If
  the audit log then fails, the notifications sweep has already committed.
  The error is returned, and calling again is safe.

Tested against PGlite in `retention.service.db.spec.ts`. The tests check
that only the expected rows go, that unread notifications stay, that the
trigger is on and still refusing deletes after a sweep, and that a failed
sweep rolls back with the trigger intact.
