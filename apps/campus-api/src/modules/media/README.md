# Media

Files clients upload straight to Cloudflare R2. campus-api signs the upload
and checks the file afterwards; the bytes never pass through it.

## The routes

| Route                    | Who                            | What                                          |
| ------------------------ | ------------------------------ | --------------------------------------------- |
| `POST /v1/uploads`       | Any full-access member         | A presigned PUT for one file                  |
| `GET /v1/uploads/limits` | Any full-access member         | The types and largest size each kind may take |
| `GET /v1/media/{id}/url` | Whoever its owner lets read it | A fresh 15-minute link to a private file      |

## An upload, start to finish

1. The client sends `kind`, `contentType`, `sizeBytes` and, for an
   attachment, `fileName` to
   `POST /v1/uploads`. It gets back `mediaId`, `uploadUrl`, `headers` and
   `expiresAt` (10 minutes). At most 30 a minute.
2. It PUTs the file to `uploadUrl` with `headers`. The URL is for
   `incoming/<media id>` in the **private** bucket, with the type and size
   signed in, so R2 refuses a PUT that differs. R2 has no presigned POST
   policy, which is why the limits live in the signature.
3. It hands `mediaId` to the endpoint that uses the file. That endpoint calls
   `MediaService.verify` first, outside any transaction:
   - a key is picked for the file to be served from, with a new random id
     each time, so a replaced picture never takes an old picture's key;
   - the upload is copied there, with the type and caching the server sets;
   - the **copy** is checked: the signed size, and first bytes that are the
     signed type. The client cannot write to that key, so what is checked is
     what will be served;
   - the upload in `incoming/` is deleted.
     A file that fails is deleted and the request answers 422
     (`UPLOAD_MISMATCH`).
4. Then, in its own transaction, it calls `MediaService.claim`, which touches
   no storage: the upload must be the caller's, of that kind, pending and
   verified. It turns `ready`.

The upload URL still works until it expires, but a PUT to it only lands in
`incoming/`. Nothing copies from there once an upload is claimed, and a
verify that is run again unmarks the upload before it overwrites the copy,
so a claim never takes a file that was not checked.

Only keys are stored, never URLs. A public file's URL is
`MEDIA_PUBLIC_URL/<key>`, built when it is read.

## Kinds

| Kind                   | Served from | Types                    | Max   | Key                                   | Kept after release |
| ---------------------- | ----------- | ------------------------ | ----- | ------------------------------------- | ------------------ |
| `avatar`               | public      | jpeg, png, webp          | 2 MB  | `avatars/<user id>/<random id>.<ext>` | No                 |
| `notice_attachment`    | private     | images, documents, text¹ | 25 MB | `notices/<random id>`                 | 7 days             |
| `feedback_attachment`  | private     | images, documents, text¹ | 25 MB | `feedback/<random id>`                | 7 days             |
| `call_chat_attachment` | private     | images, documents, text¹ | 25 MB | `call-chat/<random id>`               | 7 days             |

¹ jpeg, png, webp, gif, pdf, docx, xlsx, pptx, doc, xls, ppt, txt, csv. The
content check knows each by its first bytes: docx, xlsx and pptx as a ZIP,
doc, xls and ppt as an OLE file (which proves an Office file, not which one),
and txt and csv as UTF-16 with a byte-order mark or anything else with no
NUL, so a spreadsheet's export in any encoding passes. At most ten per
notice or piece of feedback (`maxAttachments` in the limits).

Every served file has a key of its own, so public files are cached as
immutable.

## Profile pictures

`PUT /v1/users/me/avatar` with `{ mediaId }` takes an `avatar` upload
(verify, then claim with `users.avatar_media_id` set in one transaction)
and releases the picture it replaces, which the next sweep deletes.
`DELETE /v1/users/me/avatar` releases it and clears
`users.google_picture_url` as well, so the person is left with initials and
a later Google sign-in does not bring the old picture back.

Every response that carries `avatarUrl` (session, own profile, profile
card, roster, directory, mentorship groups) builds it with
`avatarUrl()` in `users/avatar-url.ts`: `MEDIA_PUBLIC_URL/<key>` of the
uploaded picture, else Google's picture, else null. Without
`MEDIA_PUBLIC_URL` it is Google's picture alone.

## Attachments

Notices and feedback take `attachmentIds`, a list of uploads of the
caller's, in the order to show them. They are verified before the owner's
transaction and claimed inside it, like a profile picture, and linked
through `notice_attachments` and `feedback_attachments`. A file for a
call's chat is attached one at a time to the call going on in a space (see
the calls README), through `call_chat_attachments`.

Their payloads embed each file as `{id, fileName, contentType, sizeBytes,
url, urlExpiresAt}`. The url is a presigned GET of the private file that
lasts 15 minutes. Images open in the browser; anything else is sent with
`Content-Disposition: attachment`, so a text file is downloaded and never
rendered. The name comes from the upload's `fileName`, with any path and
invisible or text-direction characters taken out, and its extension set to
the type that was checked: a text file sent as `fix.bat` downloads as
`fix.txt`.

`GET /v1/media/{id}/url` signs a fresh link once one expires. Who may have
one is the owner's to say, through a reader it registers with
`MediaService.registerReader`:

| Kind                   | Who may read                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| `notice_attachment`    | whoever can see the notice (`noticesVisibleTo`), until it is removed |
| `feedback_attachment`  | admins, except one that a report names                               |
| `call_chat_attachment` | whoever may enter the call's space (`mayEnter`)                      |

Anyone else gets the same 404, whether or not the file exists. Somebody the
reader lets in, asking for a file its owner has released (a call's file once
the call ends), gets 410 `MEDIA_GONE`.

Editing a notice with `attachmentIds` replaces its list: new uploads are
claimed and dropped files released. Removing a notice releases all its
files. A call's files are released when the call ends. Feedback files are
never released; deleting an account, once that exists, will release them.

## Deleting

An owner that lets go of a file calls `MediaService.release` in the same
transaction: the row turns `removed` with a `purge_after` from its kind's
grace. The `media-sweeper` job, every 5 minutes, deletes the objects of:

- released media whose `purge_after` has passed, and
- uploads nothing claimed within an hour. `verify` refuses an upload older
  than 30 minutes, so it never races this.

Each row is marked `purged` and both its objects (the upload and the served
copy) deleted in one transaction, so a failed delete is tried again on the
next run. A key already gone counts as deleted. A PUT to an upload URL after
its file was verified leaves an object in `incoming/` that no row points
at; the bucket's lifecycle rule deletes those.

A member may have at most 20 unclaimed uploads from the last hour; the 21st
answers 429.

Recordings are not media: they have their own table and are never swept.
