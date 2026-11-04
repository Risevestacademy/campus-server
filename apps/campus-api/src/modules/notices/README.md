# Notice wall

A read view of notices, scoped to what the caller may see, plus comments on a
notice.

## Routes

| Route                            | Who                   | Returns                                        |
| -------------------------------- | --------------------- | ---------------------------------------------- |
| `GET /v1/notices`                | any full session      | a page of visible notices                      |
| `GET /v1/notices/{id}/comments`  | anyone who can see it | a page of that notice's comments, oldest first |
| `POST /v1/notices/{id}/comments` | anyone who can see it | the comment, and an audit entry                |

## Visibility

There is one definition, `noticesVisibleTo` in
[`notice-visibility.ts`](./notice-visibility.ts), used by all three routes.
Memberships are read from the database on every request, never from the token.

A member sees:

- every campus-scoped notice, with any live membership;
- every notice scoped to a cohort they hold a live membership in;
- every notice scoped to the exact cohort track their live membership names.

All four roles count, including a guest. Ended, left and expired memberships do
not. A person in several cohorts sees all of them. Admins see every notice.
The track rule is an exact match: a professor, mentor or guest without a track
does not see track notices.

The predicate is always in the `WHERE` clause. The page query and its `count`
share the same filter, so a notice the member cannot see never changes
`total`, and a page cursor/filter can never widen the set.

## Ordering

The whole result is ordered by `pinned desc, created_at desc, id desc` before
it is paged. Pinned notices therefore lead globally, not just within whichever
page they land on, and the id tie-break keeps page boundaries from repeating
or dropping a notice with the same `created_at`.

This is a deliberate reading of "pinned first within each page": it makes the
result stable and avoids a pinned notice jumping to the top of page 3. It is
recorded here because the two readings differ.

## Filters

`scope` comes from `NoticeScope`; `cohortId` is a UUID. Both are optional and
are ANDed with visibility. They only narrow: a cohort filter for a cohort the
caller is not in is an empty page, never a hidden notice or a 4xx that would
reveal one.

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
and its audit entry together. If the notice vanished or became invisible, the
answer is the same 404 as any invisible notice and nothing is written.

Comments are not tied to a notice's lifecycle by a cascade. Notices cannot be
removed on this branch (CO-31 has not landed). When its soft-remove
(`removed_at`) arrives, add `isNull(notices.removedAt)` to the visibility
predicate; existing comments stay in the table, and become unreachable while
the notice is removed.

## Audit

Every comment writes `comment_created` with the comment as subject and
`details: { noticeId }`. The actor is the caller. The comment text is not
copied into the audit log.

## Not in this work

No notice create/edit/delete, no comment edit/delete, no reactions, no
notifications, no comment counts on the notice list, and no project comments.
