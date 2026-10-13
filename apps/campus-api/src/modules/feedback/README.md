# Feedback

How a member tells the people who run the campus that something is broken,
could be better, or that somebody did something they should not have. And
how admins read it.

## The routes

| Route                     | Who                    | What                                       |
| ------------------------- | ---------------------- | ------------------------------------------ |
| `POST /v1/feedback`       | Any full-access member | Send one                                   |
| `GET /v1/feedback`        | Admins                 | List them, newest first, paginated         |
| `GET /v1/feedback/{id}`   | Admins                 | Read one whole                             |
| `PATCH /v1/feedback/{id}` | Admins                 | Mark it `resolved`, or put it back to open |

A member cannot read feedback, their own included. There is no route for it
on purpose: a report is about somebody, and the fewer places it can be read
from the better.

## What a member sends

- `type`: `bug`, `idea` or `report`.
- `title` and `details`: both required. Up to 120 and 4,000 characters.
- `about`: the "who or where" line, up to 200 characters. Who a report is
  about, or where a bug happened. It is offered on every type and required on
  none; blank is taken as not given.

And three things the client fills in, not the member:

- `reportedUserId`: the account a report is about, when the member picked a
  person rather than typing a name. Only on a `report`: an account id is an
  accusation pointed at somebody, and a bug or an idea has no business making
  one. The database refuses it too (`feedback_reported_user_on_reports`).
- `cohortId`: the cohort they were in. It has to be one the sender is in
  (an admin may name any), and it never holds the cohort in place: deleting
  the cohort empties it.
- `context`: the page, and the map, its version and their tile if they were
  on one.

Who sent it comes from the session and cannot be set. The browser or app
that sent it comes from the request's own `User-Agent`.

`context` and the user agent are what a client reported. They are hints for
whoever reads a bug, and are checked against nothing.

Text that cannot be seen is taken out before anything is checked: control
characters other than tabs and line breaks, and zero-width characters. So a
title made only of them is blank, and refused like any other blank one.

## One account, ten an hour

Counted per account, whatever the type, from the rows already saved. Not
held in memory: the API runs more than one process and sleeps between
requests, and a count that forgot would be no limit. The eleventh in an hour
is a `429 RATE_LIMITED`.

Sends from one account are taken one at a time, under a lock of that
account's own, so a burst of requests cannot each count before any of them
has saved. That lock is exercised by every test but proven by none: the
tests run on one connection, where nothing overlaps.

## Reports, and who is told

When a `report` arrives, every active admin and super admin is emailed that
there is one. The email says nothing of what the report says, and is not
given it: mail is forwarded, searched and kept long after the matter is
closed. It links to where an admin reviews it: the administration overview
of the cohort the report came from (`/campus/{cohortId}/overview` in the web
app), or the campus list when it came from no cohort.

A bug or an idea sends nothing. It waits in the list.

The emails go out one at a time, after the report is saved, and the member's
request does not wait for them. So a slow mail provider holds nobody up, and
a failed send costs the nudge and not the report. With email switched off
(`FF_EMAIL_ENABLED=false`) nothing is sent and the report is still in the
list.

The person a report names is not told.

### A report that names an admin

An admin who is reported is not the one to hear of it, to read who reported
them and what was said, or to mark it dealt with. So for the account a
report names by `reportedUserId`:

- no email is sent to them;
- it is not in their list;
- reading it or resolving it answers `404`, as if it were not there.

Every other admin sees it as usual. Only an account named by id can be kept
out: a report that names somebody in words alone cannot be matched to
anybody.

## Resolving

An admin marks a piece of feedback `resolved`, which records who and when, or
puts it back to `open`, which clears both. That is all the status is: a way
to tell what has been dealt with from what has not.

Each change writes an audit entry (`feedback_resolved`, `feedback_reopened`)
naming the admin and the feedback. The entry carries nothing of what was
written, which stays here.

## Personal data

A report is one member's words about another, by name. So:

- Only admins can read feedback.
- Nothing of its text goes into the audit log, an email or a log line.
- `submitted_by`, `reported_user_id` and `resolved_by` are foreign keys to
  `users`. When deleting an account is built, it has to decide what happens
  to what that person sent, and to what was sent about them.

## Rules the database enforces

| Rule                                                         | Constraint                                               |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| A title and details that say something                       | `feedback_title_not_blank`, `feedback_details_not_blank` |
| Details no longer than the form allows                       | `feedback_details_length`                                |
| An account is named only on a report                         | `feedback_reported_user_on_reports`                      |
| Deleting a cohort empties `cohort_id`, and never fails on it | `feedback_cohort_id_cohorts_id_fk`, `ON DELETE SET NULL` |
| Resolved by somebody at some time, or not resolved           | `feedback_resolution`                                    |

They are tested against a real PostgreSQL engine, with the committed
migrations applied, in `feedback.service.db.spec.ts`.

## Not here

- **Screenshots.** They need somewhere to be stored, which is not chosen.
- **In-app notifications** for admins. Email is the only channel until
  notifications exist.
- **A link straight to the one report** in the email. It links to the
  cohort's administration overview; the web app has no page for a single
  report to link to.
