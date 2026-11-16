import { MediaBucket, MediaKind } from './schema.js';

export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
/** How long a pending upload may wait to be claimed before it is swept. */
export const PENDING_TTL_MS = 60 * 60_000;
/** Well inside PENDING_TTL_MS, so a verify never races the sweep of the same upload. */
export const VERIFY_WINDOW_MS = 30 * 60_000;
export const MAX_PENDING_PER_USER = 20;
/** Enough of the file's start to tell what it is. */
export const SNIFF_BYTES = 4096;

const MB = 1024 * 1024;

/** Where a client's PUT lands, in the private bucket, until it is checked. */
export const uploadKeyOf = (mediaId: string) => `incoming/${mediaId}`;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export interface MediaRule {
  /** Where the checked file is served from. Uploads always land in the private bucket first. */
  bucket: MediaBucket;
  contentTypes: readonly string[];
  maxBytes: number;
  /** How long a released file is kept before it is deleted. */
  graceMs: number;
  cacheControl?: string;
  /** Where the checked file is served from; `fileId` is new for every upload. */
  key(ids: { fileId: string; userId: string }, extension: string): string;
}

export const MEDIA_RULES: Record<MediaKind, MediaRule> = {
  [MediaKind.Avatar]: {
    bucket: MediaBucket.Public,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 2 * MB,
    graceMs: 0,
    cacheControl: IMMUTABLE,
    key: ({ fileId, userId }, extension) =>
      `avatars/${userId}/${fileId}.${extension}`,
  },
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionOf(contentType: string): string {
  return EXTENSIONS[contentType] ?? 'bin';
}

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
};

/** Whether the file's first bytes are what `contentType` says it is. */
export function contentMatches(
  contentType: string,
  bytes: Uint8Array,
): boolean {
  return SIGNATURES[contentType]?.(bytes) ?? false;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((byte, i) => bytes[i] === byte)
  );
}
