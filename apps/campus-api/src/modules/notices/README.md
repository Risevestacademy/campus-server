# Notice wall

A read view of notices, scoped to what the caller may see, plus comments on a
notice.

## Routes

| Route                            | Who                   | Returns                                        |
| -------------------------------- | --------------------- | ---------------------------------------------- |
| `GET /v1/notices`                | any full session      | a page of visible notices                      |
| `GET /v1/notices/{id}/comments`  | anyone who can see it | a page of that notice's comments, oldest first |
| `POST /v1/notices/{id}/comments` | anyone who can see it | the comment, and an audit entry                |

Writing notices — create, edit, pin and remove — is the admin and staff work
in `notices.service.ts`; this wall does not change it.

## Visibility

There is one definition, `noticesVisibleTo` in
[`notice-visibility.ts`](./notice-visibility.ts), used by all three routes.
Memberships are read from the database on every request, never from the token.
It always includes `removed_at is null`, so a soft-removed notice leaves the
list, its comment list and its add route at the same time.

A member sees:

- every campus-scoped notice, with any live membership;
- every notice scoped to a cohort they hold a live membership in;
- every notice scoped to the exact cohort track their live membership names;
- every notice scoped to a mentorship group where their live membership is the
  group's mentor or one of its students.

All four roles count, including a guest. Ended, left and expired memberships do
not. A person in several cohorts sees all of them. Admins see every non-removed
notice without needing a membership.

The track rule is an exact match on `cohort_members.cohort_track_id`, not the
underlying catalogue track. Only students are required to carry a track; a
professor, mentor or guest sees track notices only when their membership names
one.

The predicate is always in the `WHERE` clause. The page query and its `count`
share the same filter, so a notice the member cannot see never changes
`total`, and a filter can never widen the set. The request's `now` is captured
once and passed to the page, the count and the comment checks, so a guest
cannot cross their deadline between them.

## Ordering and pagination

The whole visible result is ordered by `pinned desc, created_at desc, id desc`
before it is paged. Pinned notices therefore lead globally, not just within
whichever page they land on. The id tie-break keeps a page boundary from
repeating or dropping a notice with the same `created_at`.

Pagination is offset-based, like the other lists: `page`/`perPage`, 20 by
default, at most 100. Offset paging has one known limit: if a **visible** notice
is inserted while a caller is walking pages, an item can move across a page
boundary and repeat. A hidden notice never does, because it is not in the
visible set or the count. A cursor would remove the limit; the project has no
cursor convention, so this route keeps offset paging and the documented
behaviour.

## Filters

`scope` comes from `NoticeScope`; `cohortId` is a UUID. Both are optional and
are ANDed with visibility. `cohortId` matches the notice's own `cohort_id`, so
it does not include campus notices. They only narrow: a cohort filter for a
cohort the caller is not in is an empty page, never a hidden notice or a 4xx
that would reveal one.

## Comments

Comments live in the `comments` table (`src/modules/comments/schema.ts`) with a
polymorphic `target_type` / `target_id`. There is deliberately no foreign key
on `target_id`, for the same reason notifications have none: the target may be
a notice now and a project later, and a comment is a record that outlives the
thing it is about. `comments_target_type_known` keeps the type to `notice`
until the project comments work widens it.

Listing is chronological (oldest first), with the id breaking ties. Adding a
comment resolves the notice through the same visibility rule, inside the
transaction and under `FOR SHARE` on the notice row, then writes the comment
and its audit entry together. The visibility is checked again after the insert;
if the notice has gone, the transaction rolls back and nothing is written. If
the notice vanished or became invisible, the answer is the same 404 as any
invisible notice.

Comments are not tied to a notice's lifecycle by a cascade. A notice is
soft-removed (`removed_at`), never deleted by the API; its comments stay in the
table and become unreachable while the notice is removed. A member who leaves
the cohort loses access to the notice and its comments; the comments remain
visible to the people who can still see the notice.

## Audit

Every comment writes `comment_created` with the comment as subject and
`details: { noticeId }`. The actor is the caller. The comment text is not
copied into the audit log.

## Not in this work

No notice create/edit/delete changes, no comment edit/delete, no reactions, no
notifications, no comment counts on the notice list, and no project comments.
