import { MediaKind } from '../schema.js';
import type { MediaStorage } from '../media-storage.js';
import { MediaService } from '../media.service.js';

export const PDF = new TextEncoder().encode('%PDF-1.7\n%âã\n');

/** R2 as a map of `bucket:key` to bytes, for tests. */
export function memoryMediaStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage: MediaStorage = {
    async signUpload(key) {
      return { url: `https://r2.test/${key}`, headers: {} };
    },
    async copyUpload(uploadKey, to) {
      const bytes = objects.get(`private:${uploadKey}`);
      if (!bytes) throw new Error('NoSuchKey');
      objects.set(`${to.bucket}:${to.key}`, bytes);
    },
    async head(bucket, key) {
      const bytes = objects.get(`${bucket}:${key}`);
      return bytes ? { sizeBytes: bytes.length, contentType: undefined } : null;
    },
    async readStart(bucket, key, length) {
      return (
        objects.get(`${bucket}:${key}`)?.subarray(0, length) ?? new Uint8Array()
      );
    },
    async delete(bucket, key) {
      objects.delete(`${bucket}:${key}`);
    },
    publicUrl: (key) => `https://media.test/${key}`,
    signRead: async (key) => `https://r2.test/${key}?read`,
  };

  /** Asks for an upload as `userId` and PUTs `bytes` to it, as a client would. */
  const upload = async (
    media: MediaService,
    userId: string,
    kind: MediaKind,
    {
      bytes = PDF,
      contentType = 'application/pdf',
      fileName = 'plan.pdf',
    } = {},
  ): Promise<string> => {
    const { mediaId } = await media.createUpload(
      userId,
      { kind, contentType, sizeBytes: bytes.length, fileName },
      new Date(),
    );
    objects.set(`private:incoming/${mediaId}`, bytes);
    return mediaId;
  };

  return { objects, storage, upload };
}

/** A MediaService with nothing configured: it releases files, and refuses uploads with a 503. */
export function mediaWithoutStorage(db: unknown): MediaService {
  return new MediaService(
    db as never,
    null,
    { register: () => undefined } as never,
    { setContext: () => undefined, error: () => undefined } as never,
  );
}
