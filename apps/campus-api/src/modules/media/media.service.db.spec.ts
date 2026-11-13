import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { users } from '../users/schema.js';
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
  PENDING_TTL_MS,
  VERIFY_WINDOW_MS,
} from './media-rules.js';
import type { MediaStorage, ServedFile, UploadTerms } from './media-storage.js';
import { MediaService } from './media.service.js';
import { MediaBucket, MediaKind, MediaStatus, media } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const logger = { setContext: () => undefined, error: () => undefined };
const scheduler = { register: () => undefined };
const NOW = new Date('2026-11-13T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const OTHER_WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x99, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const NOT_AN_IMAGE = new Uint8Array(WEBP.length).fill(0x41);

interface FakeObject {
  bytes: Uint8Array;
  contentType: string;
  cacheControl?: string;
}

const PUBLIC = MediaBucket.Public;
const PRIVATE = MediaBucket.Private;

let objects: Map<string, FakeObject>;
let signed: { key: string; terms: UploadTerms }[];
let deleted: string[];
let failDeletes: boolean;
let failSigning: boolean;
let service: MediaService;
let alice: string;
let bob: string;

const at2 = (bucket: MediaBucket, key: string) => `${bucket}:${key}`;
const upload = (key: string, bytes: Uint8Array) =>
  objects.set(at2(PRIVATE, key), { bytes, contentType: 'image/webp' });
const served = (key: string) => objects.get(at2(PUBLIC, key));

const avatar = (sizeBytes = WEBP.length, contentType = 'image/webp') => ({
  kind: MediaKind.Avatar,
  contentType,
  sizeBytes,
});

async function rowOf(id: string) {
  const [row] = await db.select().from(media).where(eq(media.id, id));
  return row;
}

const verify = (id: string, userId = alice, now = at(1000)) =>
  service.verify(id, MediaKind.Avatar, userId, now);
const claim = (id: string, userId = alice) =>
  db.transaction((tx) =>
    service.claim(tx as never, id, MediaKind.Avatar, userId, at(2000)),
  );

/** Asks for an upload and PUTs `bytes` to it, as a client would. */
async function uploaded(bytes = WEBP, userId = alice) {
  const { mediaId } = await service.createUpload(userId, avatar(), NOW);
  const key = signed.at(-1)!.key;
  upload(key, bytes);
  return { mediaId, uploadKey: key };
}

async function accepted(bytes = WEBP) {
  const { mediaId, uploadKey } = await uploaded(bytes);
  await verify(mediaId);
  const row = await claim(mediaId);
  return { mediaId, uploadKey, key: row.key! };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(sql`truncate media, users cascade`);
  objects = new Map();
  signed = [];
  deleted = [];
  failDeletes = false;
  failSigning = false;
  const storage: MediaStorage = {
    async signUpload(key, terms) {
      if (failSigning) throw new Error('cannot sign');
      signed.push({ key, terms });
      return {
        url: `https://r2.test/${key}?signed`,
        headers: { 'Content-Type': terms.contentType },
      };
    },
    async copyUpload(uploadKey, to: ServedFile) {
      const from = objects.get(at2(PRIVATE, uploadKey));
      if (!from) throw new Error('NoSuchKey');
      objects.set(at2(to.bucket, to.key), {
        bytes: from.bytes,
        contentType: to.contentType,
        cacheControl: to.cacheControl,
      });
    },
    async head(bucket, key) {
      const object = objects.get(at2(bucket, key));
      return object
        ? { sizeBytes: object.bytes.length, contentType: object.contentType }
        : null;
    },
    async readStart(bucket, key, bytes) {
      return (
        objects.get(at2(bucket, key))?.bytes.subarray(0, bytes) ??
        new Uint8Array()
      );
    },
    async delete(bucket, key) {
      if (failDeletes) throw new Error('R2 is down');
      deleted.push(at2(bucket, key));
      objects.delete(at2(bucket, key));
    },
    publicUrl: (key) => `https://media.test/${key}`,
  };
  service = new MediaService(
    db as never,
    storage,
    scheduler as never,
    logger as never,
  );
  [{ id: alice }, { id: bob }] = await db
    .insert(users)
    .values([{ email: 'alice@campus.local' }, { email: 'bob@campus.local' }])
    .returning();
});

describe('createUpload', () => {
  it('signs a PUT for the exact type and size into the private bucket', async () => {
    const upload = await service.createUpload(alice, avatar(), NOW);

    expect(upload.expiresAt).toEqual(at(10 * 60_000));
    expect(signed).toEqual([
      {
        key: `incoming/${upload.mediaId}`,
        terms: { contentType: 'image/webp', sizeBytes: WEBP.length },
      },
    ]);
    expect(await rowOf(upload.mediaId)).toMatchObject({
      kind: MediaKind.Avatar,
      bucket: PUBLIC,
      uploadKey: `incoming/${upload.mediaId}`,
      key: null,
      status: MediaStatus.Pending,
      uploadedBy: alice,
    });
  });

  it('refuses a type or size the kind does not take', async () => {
    await expect(
      service.createUpload(alice, avatar(100, 'image/gif'), NOW),
    ).rejects.toThrow(UploadTypeNotAllowedException);
    await expect(
      service.createUpload(alice, avatar(2 * 1024 * 1024 + 1), NOW),
    ).rejects.toThrow(UploadTooLargeException);
    expect(signed).toEqual([]);
  });

  it('records nothing when signing fails', async () => {
    failSigning = true;
    await expect(service.createUpload(alice, avatar(), NOW)).rejects.toThrow();
    expect(await db.select().from(media)).toEqual([]);
  });

  it('refuses once too many of the last hour’s uploads are unused', async () => {
    for (let i = 0; i < MAX_PENDING_PER_USER; i++) {
      await service.createUpload(alice, avatar(), NOW);
    }
    await expect(service.createUpload(alice, avatar(), NOW)).rejects.toThrow(
      TooManyPendingUploadsException,
    );
    await expect(
      service.createUpload(bob, avatar(), NOW),
    ).resolves.toBeDefined();
    await expect(
      service.createUpload(alice, avatar(), at(PENDING_TTL_MS)),
    ).resolves.toBeDefined();
  });

  it('answers 503 when storage is not configured', async () => {
    const bare = new MediaService(
      db as never,
      null,
      scheduler as never,
      logger as never,
    );
    await expect(bare.createUpload(alice, avatar(), NOW)).rejects.toThrow(
      MediaNotConfiguredException,
    );
    await expect(bare.sweep(NOW)).resolves.toBeUndefined();
  });
});

describe('verify and claim', () => {
  it('serves a checked copy under a fresh key, and drops the upload', async () => {
    const { mediaId, uploadKey } = await uploaded();

    await verify(mediaId);
    const row = await claim(mediaId);

    expect(row).toMatchObject({ status: MediaStatus.Ready, readyAt: at(2000) });
    expect(row.key).toMatch(
      new RegExp(`^avatars/${alice}/[0-9a-f-]{36}\\.webp$`),
    );
    expect(row.key).not.toContain(mediaId);
    expect(served(row.key!)).toEqual({
      bytes: WEBP,
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(objects.has(at2(PRIVATE, uploadKey))).toBe(false);
  });

  it('serves each replacement from a key of its own', async () => {
    const first = await accepted();
    const second = await accepted();

    expect(second.key).not.toBe(first.key);
    expect(served(first.key)).toBeDefined();
    expect(served(second.key)).toBeDefined();
  });

  it('ignores a PUT to the same URL after the file is accepted', async () => {
    const { mediaId, uploadKey, key } = await accepted();

    upload(uploadKey, OTHER_WEBP);

    expect(served(key)!.bytes).toEqual(WEBP);
    await expect(verify(mediaId)).rejects.toThrow(UploadNotFoundException);
    await expect(claim(mediaId)).rejects.toThrow(UploadNotFoundException);
    expect(served(key)!.bytes).toEqual(WEBP);
  });

  it('serves what verify checked, whatever is PUT before the claim', async () => {
    const { mediaId, uploadKey } = await uploaded();
    await verify(mediaId);

    upload(uploadKey, NOT_AN_IMAGE);
    const row = await claim(mediaId);

    expect(served(row.key!)!.bytes).toEqual(WEBP);
  });

  it('will not claim while a retried verify has failed', async () => {
    const { mediaId, uploadKey } = await uploaded();
    await verify(mediaId);

    upload(uploadKey, NOT_AN_IMAGE);
    await expect(verify(mediaId)).rejects.toThrow(UploadMismatchException);

    await expect(claim(mediaId)).rejects.toThrow(UploadMismatchException);
  });

  it('checks again, under the same key, when verify is retried', async () => {
    const { mediaId } = await uploaded();

    await verify(mediaId);
    const { key } = await rowOf(mediaId);
    await verify(mediaId);

    expect((await rowOf(mediaId)).key).toBe(key);
    expect((await claim(mediaId)).key).toBe(key);
  });

  it('refuses when nothing was uploaded, and keeps the row pending', async () => {
    const { mediaId } = await service.createUpload(alice, avatar(), NOW);

    await expect(verify(mediaId)).rejects.toThrow(UploadMismatchException);
    expect((await rowOf(mediaId)).status).toBe(MediaStatus.Pending);
  });

  it('deletes both copies of a file that is not what it claims to be', async () => {
    const { mediaId, uploadKey } = await uploaded(NOT_AN_IMAGE);

    await expect(verify(mediaId)).rejects.toThrow(UploadMismatchException);
    const { key } = await rowOf(mediaId);
    expect(objects.has(at2(PRIVATE, uploadKey))).toBe(false);
    expect(served(key!)).toBeUndefined();
    await expect(claim(mediaId)).rejects.toThrow(UploadMismatchException);
  });

  it('will not claim an upload that was never verified', async () => {
    const { mediaId } = await uploaded();

    await expect(claim(mediaId)).rejects.toThrow(UploadMismatchException);
  });

  it('is only for the uploader, and only once', async () => {
    const { mediaId } = await uploaded();

    await expect(verify(mediaId, bob)).rejects.toThrow(UploadNotFoundException);
    await verify(mediaId);
    await expect(claim(mediaId, bob)).rejects.toThrow(UploadNotFoundException);
    await claim(mediaId);
    await expect(claim(mediaId)).rejects.toThrow(UploadNotFoundException);
  });

  it('refuses an upload too close to being swept', async () => {
    const { mediaId } = await uploaded();

    await expect(verify(mediaId, alice, at(VERIFY_WINDOW_MS))).rejects.toThrow(
      UploadNotFoundException,
    );
    expect(await rowOf(mediaId)).toMatchObject({ key: null });
  });
});

describe('release and sweep', () => {
  it('deletes a released avatar on the next sweep', async () => {
    const { mediaId, key } = await accepted();

    await service.release(db as never, [mediaId], at(3000));
    expect(await rowOf(mediaId)).toMatchObject({
      status: MediaStatus.Removed,
      purgeAfter: at(3000),
    });

    await service.sweep(at(4000));
    expect(served(key)).toBeUndefined();
    expect(await rowOf(mediaId)).toMatchObject({
      status: MediaStatus.Purged,
      purgedAt: at(4000),
    });
  });

  it('leaves ready media alone', async () => {
    const { mediaId, key } = await accepted();

    await service.sweep(at(PENDING_TTL_MS * 2));
    expect(served(key)).toBeDefined();
    expect((await rowOf(mediaId)).status).toBe(MediaStatus.Ready);
  });

  it('purges both copies of uploads left unclaimed for an hour', async () => {
    const verified = await uploaded();
    await verify(verified.mediaId);
    const { key } = await rowOf(verified.mediaId);
    const unverified = await uploaded();

    await service.sweep(at(PENDING_TTL_MS - 1));
    expect(deleted).toEqual([`private:${verified.uploadKey}`]);

    await service.sweep(at(PENDING_TTL_MS));
    expect(served(key!)).toBeUndefined();
    expect(objects.has(at2(PRIVATE, unverified.uploadKey))).toBe(false);
    expect((await rowOf(verified.mediaId)).status).toBe(MediaStatus.Purged);
    expect((await rowOf(unverified.mediaId)).status).toBe(MediaStatus.Purged);
  });

  it('keeps the row to try again when the delete fails', async () => {
    const { mediaId } = await accepted();
    await service.release(db as never, [mediaId], NOW);

    failDeletes = true;
    await service.sweep(at(1000));
    expect((await rowOf(mediaId)).status).toBe(MediaStatus.Removed);

    failDeletes = false;
    await service.sweep(at(2000));
    expect((await rowOf(mediaId)).status).toBe(MediaStatus.Purged);
  });

  it('releases only ready media', async () => {
    const { mediaId } = await uploaded();

    await service.release(db as never, [mediaId], NOW);
    expect((await rowOf(mediaId)).status).toBe(MediaStatus.Pending);
  });
});
