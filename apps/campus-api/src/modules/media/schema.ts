import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from '../users/schema.js';

export enum MediaKind {
  Avatar = 'avatar',
}

export enum MediaBucket {
  Public = 'public',
  Private = 'private',
}

export enum MediaStatus {
  /** Signed for upload; nothing has claimed it yet. */
  Pending = 'pending',
  Ready = 'ready',
  /** Let go by its owner; the object is deleted once `purge_after` passes. */
  Removed = 'removed',
  /** The object is gone from the bucket. */
  Purged = 'purged',
}

export const mediaKindEnum = pgEnum('media_kind', MediaKind);
export const mediaBucketEnum = pgEnum('media_bucket', MediaBucket);
export const mediaStatusEnum = pgEnum('media_status', MediaStatus);

/**
 * A file a client uploaded straight to R2. What it belongs to is recorded by
 * the owner (`users.avatar_media_id`, …), pointing here.
 *
 * The client can only write `upload_key`, in the private bucket. The file is
 * served from `key`, which only the server writes, so reusing an upload URL
 * cannot change a file once it is checked.
 */
export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: mediaKindEnum('kind').notNull(),
    /** Where the file is served from, under `key`. */
    bucket: mediaBucketEnum('bucket').notNull(),
    uploadKey: varchar('upload_key', { length: 512 }).notNull(),
    /** Picked fresh when the upload is verified; null until then. */
    key: varchar('key', { length: 512 }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    contentType: varchar('content_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: mediaStatusEnum('status').notNull().default(MediaStatus.Pending),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When `key` last held a copy that passed the check; null while it may not. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    /** Null while kept: nothing deletes it on a timer. */
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('media_upload_key_unique').on(table.uploadKey),
    uniqueIndex('media_key_unique').on(table.key),
    index('media_pending_idx')
      .on(table.uploadedBy, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('media_purge_idx')
      .on(table.purgeAfter)
      .where(sql`${table.status} = 'removed'`),
    check('media_size_positive', sql`${table.sizeBytes} > 0`),
    check(
      'media_verified_has_key',
      sql`${table.verifiedAt} is null or ${table.key} is not null`,
    ),
    check(
      'media_status_dates',
      sql`(${table.status} <> 'ready' or (${table.readyAt} is not null and ${table.verifiedAt} is not null))
        and (${table.status} <> 'removed' or ${table.removedAt} is not null)
        and (${table.status} <> 'purged' or ${table.purgedAt} is not null)`,
    ),
  ],
);

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
