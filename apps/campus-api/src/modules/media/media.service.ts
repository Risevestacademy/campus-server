import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
  type Tx,
} from '../../infra/database/database.constants.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import {
  MediaNotConfiguredException,
  MediaNotFoundException,
  TooManyPendingUploadsException,
  UploadMismatchException,
  UploadNotFoundException,
  UploadTooLargeException,
  UploadTypeNotAllowedException,
} from './media.exceptions.js';
import {
  MAX_PENDING_PER_USER,
  MEDIA_RULES,
  PENDING_TTL_MS,
  SIGNED_READ_TTL_SECONDS,
  SNIFF_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  VERIFY_WINDOW_MS,
  cleanFileName,
  contentMatches,
  extensionOf,
  opensInline,
  uploadKeyOf,
} from './media-rules.js';
import { MEDIA_STORAGE, type MediaStorage } from './media-storage.js';
import {
  MediaBucket,
  MediaKind,
  MediaStatus,
  media,
  type Media,
} from './schema.js';

export const SWEEP_JOB_MS = 5 * 60_000;
const SWEEP_BATCH = 100;

export interface UploadRequest {
  kind: MediaKind;
  contentType: string;
  sizeBytes: number;
  fileName?: string;
}

export interface CreatedUpload {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedRead {
  url: string;
  expiresAt: Date;
}

/** A private file as its owner's payload shows it, with a link to read it. */
export interface Attachment {
  id: string;
  fileName: string | null;
  contentType: string;
  sizeBytes: number;
  url: string;
  urlExpiresAt: Date;
}

/** Whether this person may read this file, as the owner it belongs to decides. */
export type MediaReader = (
  viewer: AuthenticatedUser,
  mediaId: string,
  now: Date,
) => Promise<boolean>;

@Injectable()
export class MediaService implements OnModuleInit {
  private readonly readers = new Map<MediaKind, MediaReader>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage | null,
    private readonly scheduler: Scheduler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MediaService.name);
  }

  onModuleInit(): void {
    this.scheduler.register({
      name: 'media-sweeper',
      everyMs: SWEEP_JOB_MS,
      run: (now) => this.sweep(now),
    });
  }

  async createUpload(
    userId: string,
    request: UploadRequest,
    now: Date,
  ): Promise<CreatedUpload> {
    const storage = this.requireStorage();
    const rule = MEDIA_RULES[request.kind];
    if (!rule.contentTypes.includes(request.contentType)) {
      throw new UploadTypeNotAllowedException(
        `A ${request.kind} must be one of ${rule.contentTypes.join(', ')}`,
        { allowed: rule.contentTypes },
      );
    }
    if (request.sizeBytes > rule.maxBytes) {
      throw new UploadTooLargeException(
        `A ${request.kind} may be at most ${rule.maxBytes} bytes`,
        { maxBytes: rule.maxBytes },
      );
    }

    const [{ pending }] = await this.db
      .select({ pending: count() })
      .from(media)
      .where(
        and(
          eq(media.uploadedBy, userId),
          eq(media.status, MediaStatus.Pending),
          gt(media.createdAt, new Date(now.getTime() - PENDING_TTL_MS)),
        ),
      );
    if (pending >= MAX_PENDING_PER_USER) {
      throw new TooManyPendingUploadsException(
        'Too many uploads waiting to be used; try again later',
      );
    }

    const mediaId = randomUUID();
    const uploadKey = uploadKeyOf(mediaId);
    const signed = await storage.signUpload(
      uploadKey,
      { contentType: request.contentType, sizeBytes: request.sizeBytes },
      UPLOAD_URL_TTL_SECONDS,
    );
    await this.db.insert(media).values({
      id: mediaId,
      kind: request.kind,
      bucket: rule.bucket,
      uploadKey,
      uploadedBy: userId,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
      fileName: rule.named
        ? cleanFileName(request.fileName, request.contentType)
        : null,
      createdAt: now,
    });
    return {
      mediaId,
      uploadUrl: signed.url,
      headers: signed.headers,
      expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  /**
   * Copies the caller's upload to a fresh key and checks the copy: the client
   * cannot write there, so what is checked is what is served. Each attempt
   * gets its own key and is recorded only while the upload is still pending,
   * so a slower attempt never writes over a copy that was accepted. Run it
   * before the owner's transaction, then `claim` inside it. A file that fails
   * is deleted.
   */
  async verify(
    mediaId: string,
    kind: MediaKind,
    userId: string,
    now: Date,
  ): Promise<void> {
    const storage = this.requireStorage();
    const row = await this.pendingUpload(this.db, mediaId, kind, userId);
    if (now.getTime() - row.createdAt.getTime() >= VERIFY_WINDOW_MS) {
      throw new UploadNotFoundException(
        `No ${kind} upload of yours with that id is waiting`,
      );
    }
    if (!(await storage.head(MediaBucket.Private, row.uploadKey))) {
      if (row.verifiedAt) return;
      throw new UploadMismatchException('Nothing was uploaded for that id');
    }
    const rule = MEDIA_RULES[kind];
    const served = {
      bucket: row.bucket,
      key: rule.key(
        { fileId: randomUUID(), userId: row.uploadedBy },
        extensionOf(row.contentType),
      ),
    };
    await storage.copyUpload(row.uploadKey, {
      ...served,
      contentType: row.contentType,
      cacheControl: rule.cacheControl,
    });
    const copy = await storage.head(served.bucket, served.key);
    const fits =
      copy !== null &&
      copy.sizeBytes === row.sizeBytes &&
      contentMatches(
        row.contentType,
        await storage.readStart(served.bucket, served.key, SNIFF_BYTES),
      );
    await storage.delete(MediaBucket.Private, row.uploadKey);
    if (!fits) {
      await storage.delete(served.bucket, served.key);
      throw new UploadMismatchException(
        `The uploaded file is not the ${row.contentType} of ${row.sizeBytes} bytes it was signed for`,
      );
    }

    const replaced = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ key: media.key })
        .from(media)
        .where(and(eq(media.id, row.id), eq(media.status, MediaStatus.Pending)))
        .for('update');
      if (!current) return null;
      await tx
        .update(media)
        .set({ key: served.key, verifiedAt: now })
        .where(eq(media.id, row.id));
      return current;
    });
    if (!replaced) {
      await storage.delete(served.bucket, served.key);
      throw new UploadNotFoundException('That upload has already been used');
    }
    if (replaced.key) {
      await storage.delete(served.bucket, replaced.key).catch((err) => {
        this.logger.error(
          { err, mediaId: row.id },
          'deleting a replaced copy failed',
        );
      });
    }
  }

  /**
   * Makes a verified upload ready for an owner to point at. Run it in the
   * owner's transaction; it does not touch storage.
   */
  async claim(
    tx: Tx,
    mediaId: string,
    kind: MediaKind,
    userId: string,
    now: Date,
  ): Promise<Media> {
    const row = await this.pendingUpload(tx, mediaId, kind, userId, true);
    if (!row.verifiedAt) {
      throw new UploadMismatchException('That upload has not been verified');
    }
    const [ready] = await tx
      .update(media)
      .set({ status: MediaStatus.Ready, readyAt: now })
      .where(eq(media.id, row.id))
      .returning();
    return ready;
  }

  /** `verify` for each of a list of uploads, once each. */
  async verifyAll(
    mediaIds: readonly string[],
    kind: MediaKind,
    userId: string,
    now: Date,
  ): Promise<void> {
    await Promise.all(
      [...new Set(mediaIds)].map((id) => this.verify(id, kind, userId, now)),
    );
  }

  /** `claim` for each of a list of uploads, in the order given. */
  async claimAll(
    tx: Tx,
    mediaIds: readonly string[],
    kind: MediaKind,
    userId: string,
    now: Date,
  ): Promise<Media[]> {
    const claimed: Media[] = [];
    for (const id of new Set(mediaIds)) {
      claimed.push(await this.claim(tx, id, kind, userId, now));
    }
    return claimed;
  }

  private async pendingUpload(
    executor: DbExecutor,
    mediaId: string,
    kind: MediaKind,
    userId: string,
    lock = false,
  ): Promise<Media> {
    const query = executor
      .select()
      .from(media)
      .where(
        and(
          eq(media.id, mediaId),
          eq(media.kind, kind),
          eq(media.uploadedBy, userId),
          eq(media.status, MediaStatus.Pending),
        ),
      );
    const [row] = lock ? await query.for('update') : await query;
    if (!row) {
      throw new UploadNotFoundException(
        `No ${kind} upload of yours with that id is waiting`,
      );
    }
    return row;
  }

  /** Lets go of ready media; each is deleted once its kind's grace has passed. */
  async release(
    executor: DbExecutor,
    mediaIds: string[],
    now: Date,
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    const purgeAfter = sql.join(
      Object.entries(MEDIA_RULES).map(
        ([kind, rule]) =>
          sql`when ${kind} then ${new Date(now.getTime() + rule.graceMs).toISOString()}::timestamptz`,
      ),
      sql` `,
    );
    await executor
      .update(media)
      .set({
        status: MediaStatus.Removed,
        removedAt: now,
        purgeAfter: sql`case ${media.kind} ${purgeAfter} end`,
      })
      .where(
        and(inArray(media.id, mediaIds), eq(media.status, MediaStatus.Ready)),
      );
  }

  publicUrl(key: string): string {
    return this.requireStorage().publicUrl(key);
  }

  /** Called by each owner of a private kind, once, as its module starts. */
  registerReader(kind: MediaKind, reader: MediaReader): void {
    this.readers.set(kind, reader);
  }

  /**
   * A fresh link to a private file, for someone its owner lets read it.
   * Anything else is the same 404, so a file's existence does not leak.
   */
  async readUrl(
    viewer: AuthenticatedUser,
    mediaId: string,
    now: Date,
  ): Promise<SignedRead> {
    const [row] = await this.db
      .select()
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.status, MediaStatus.Ready)));
    const reader = row && this.readers.get(row.kind);
    if (!row || !reader || !(await reader(viewer, mediaId, now))) {
      throw new MediaNotFoundException(`File ${mediaId} not found`);
    }
    return this.signRead(row, now);
  }

  /** Each ready private file, with a link to read it; an owner's payload embeds these. */
  async attachments(rows: readonly Media[], now: Date): Promise<Attachment[]> {
    return Promise.all(
      rows.map(async (row) => {
        const read = await this.signRead(row, now);
        return {
          id: row.id,
          fileName: row.fileName,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          url: read.url,
          urlExpiresAt: read.expiresAt,
        };
      }),
    );
  }

  private async signRead(row: Media, now: Date): Promise<SignedRead> {
    const url = await this.requireStorage().signRead(
      row.key!,
      { inline: opensInline(row.contentType), fileName: row.fileName },
      SIGNED_READ_TTL_SECONDS,
    );
    return {
      url,
      expiresAt: new Date(now.getTime() + SIGNED_READ_TTL_SECONDS * 1000),
    };
  }

  /** Deletes the files of abandoned uploads and of released media whose grace is over. */
  async sweep(now: Date): Promise<void> {
    if (!this.storage) return;
    const abandoned = await this.db
      .select({ id: media.id })
      .from(media)
      .where(
        and(
          eq(media.status, MediaStatus.Pending),
          lte(media.createdAt, new Date(now.getTime() - PENDING_TTL_MS)),
        ),
      )
      .orderBy(asc(media.createdAt))
      .limit(SWEEP_BATCH);
    const released = await this.db
      .select({ id: media.id })
      .from(media)
      .where(
        and(eq(media.status, MediaStatus.Removed), lte(media.purgeAfter, now)),
      )
      .orderBy(asc(media.purgeAfter))
      .limit(SWEEP_BATCH);

    for (const { id } of abandoned) {
      await this.purge(id, MediaStatus.Pending, now);
    }
    for (const { id } of released) {
      await this.purge(id, MediaStatus.Removed, now);
    }
  }

  /**
   * Marks it purged and deletes its files in one transaction, so a failed
   * delete leaves it to try again, and a claim that got there first wins.
   */
  private async purge(id: string, from: MediaStatus, now: Date): Promise<void> {
    const storage = this.requireStorage();
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(media)
          .set({ status: MediaStatus.Purged, purgedAt: now })
          .where(and(eq(media.id, id), eq(media.status, from)))
          .returning({
            bucket: media.bucket,
            key: media.key,
            uploadKey: media.uploadKey,
          });
        if (!row) return;
        await storage.delete(MediaBucket.Private, row.uploadKey);
        if (row.key) await storage.delete(row.bucket, row.key);
      });
    } catch (err) {
      this.logger.error({ err, mediaId: id }, 'media purge failed');
    }
  }

  private requireStorage(): MediaStorage {
    if (!this.storage) {
      throw new MediaNotConfiguredException('Uploads are not available here');
    }
    return this.storage;
  }
}
