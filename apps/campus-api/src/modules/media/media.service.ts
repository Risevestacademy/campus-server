import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import {
  DRIZZLE,
  type Db,
  type DbExecutor,
  type Tx,
} from '../../infra/database/database.constants.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import {
  MediaNotConfiguredException,
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
  SNIFF_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  VERIFY_WINDOW_MS,
  contentMatches,
  extensionOf,
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
}

export interface CreatedUpload {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

@Injectable()
export class MediaService implements OnModuleInit {
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
   * Copies the caller's upload to a key of its own, picked fresh, and checks
   * the copy: the client cannot write there, so what is checked is what is
   * served. Run it before the owner's transaction, then `claim` inside it.
   * A file that fails is deleted.
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
    const rule = MEDIA_RULES[kind];
    const key = row.key ?? (await this.reserveKey(row));
    const served = { bucket: row.bucket, key };

    if (await storage.head(MediaBucket.Private, row.uploadKey)) {
      await this.unverify(row.id);
      await storage.copyUpload(row.uploadKey, {
        ...served,
        contentType: row.contentType,
        cacheControl: rule.cacheControl,
      });
    }
    const copy = await storage.head(served.bucket, served.key);
    if (!copy) {
      throw new UploadMismatchException('Nothing was uploaded for that id');
    }
    const fits =
      copy.sizeBytes === row.sizeBytes &&
      contentMatches(
        row.contentType,
        await storage.readStart(served.bucket, served.key, SNIFF_BYTES),
      );
    await storage.delete(MediaBucket.Private, row.uploadKey);
    if (!fits) {
      await this.unverify(row.id);
      await storage.delete(served.bucket, served.key);
      throw new UploadMismatchException(
        `The uploaded file is not the ${row.contentType} of ${row.sizeBytes} bytes it was signed for`,
      );
    }
    await this.db
      .update(media)
      .set({ verifiedAt: now })
      .where(and(eq(media.id, row.id), eq(media.status, MediaStatus.Pending)));
  }

  /**
   * Before the served copy is overwritten or deleted, so a claim cannot take
   * it meanwhile. Refuses once the upload has been claimed: its copy is fixed.
   */
  private async unverify(id: string): Promise<void> {
    const [row] = await this.db
      .update(media)
      .set({ verifiedAt: null })
      .where(and(eq(media.id, id), eq(media.status, MediaStatus.Pending)))
      .returning({ id: media.id });
    if (!row) {
      throw new UploadNotFoundException('That upload has already been used');
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

  /** Never the media id, nor anything an earlier file was served from. */
  private async reserveKey(row: Media): Promise<string> {
    const key = MEDIA_RULES[row.kind].key(
      { fileId: randomUUID(), userId: row.uploadedBy },
      extensionOf(row.contentType),
    );
    const [reserved] = await this.db
      .update(media)
      .set({ key })
      .where(and(eq(media.id, row.id), isNull(media.key)))
      .returning({ key: media.key });
    if (reserved?.key) return reserved.key;
    const [current] = await this.db
      .select({ key: media.key })
      .from(media)
      .where(eq(media.id, row.id));
    return current.key!;
  }

  /** Lets go of ready media; each is deleted once its kind's grace has passed. */
  async release(
    executor: DbExecutor,
    mediaIds: string[],
    now: Date,
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    for (const [kind, rule] of Object.entries(MEDIA_RULES)) {
      await executor
        .update(media)
        .set({
          status: MediaStatus.Removed,
          removedAt: now,
          purgeAfter: new Date(now.getTime() + rule.graceMs),
        })
        .where(
          and(
            inArray(media.id, mediaIds),
            eq(media.kind, kind as MediaKind),
            eq(media.status, MediaStatus.Ready),
          ),
        );
    }
  }

  publicUrl(key: string): string {
    return this.requireStorage().publicUrl(key);
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
