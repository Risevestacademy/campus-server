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
const DAY_MS = 24 * 60 * 60_000;
export const SIGNED_READ_TTL_SECONDS = 15 * 60;
export const MAX_ATTACHMENTS = 10;
export const FILE_NAME_MAX_LENGTH = 255;

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
  /** Whether the upload carries the file's name, to show and to download it as. */
  named?: boolean;
  /** Where the checked file is served from; `fileId` is new for every upload. */
  key(ids: { fileId: string; userId: string }, extension: string): string;
}

const IMAGES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const ATTACHMENT_TYPES = [
  ...IMAGES,
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/csv',
] as const;

const attachment = (prefix: string): MediaRule => ({
  bucket: MediaBucket.Private,
  contentTypes: ATTACHMENT_TYPES,
  maxBytes: 25 * MB,
  graceMs: 7 * DAY_MS,
  named: true,
  key: ({ fileId }) => `${prefix}/${fileId}`,
});

export const MEDIA_RULES: Record<MediaKind, MediaRule> = {
  [MediaKind.Avatar]: {
    bucket: MediaBucket.Public,
    contentTypes: IMAGES,
    maxBytes: 2 * MB,
    graceMs: 0,
    cacheControl: IMMUTABLE,
    key: ({ fileId, userId }, extension) =>
      `avatars/${userId}/${fileId}.${extension}`,
  },
  [MediaKind.NoticeAttachment]: attachment('notices'),
  [MediaKind.FeedbackAttachment]: attachment('feedback'),
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

export function extensionOf(contentType: string): string {
  return EXTENSIONS[contentType] ?? 'bin';
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const zip = (b: Uint8Array) => startsWith(b, ZIP);
const ole = (b: Uint8Array) => startsWith(b, OLE);

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  'image/gif': (b) =>
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    zip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': zip,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    zip,
  // Proves an OLE file, not which Office one.
  'application/msword': ole,
  'application/vnd.ms-excel': ole,
  'application/vnd.ms-powerpoint': ole,
  'text/plain': isText,
  'text/csv': isText,
};

/**
 * Text in whatever encoding a spreadsheet saved it: UTF-16 when it starts
 * with a byte-order mark, otherwise anything without a NUL, which every
 * binary format has early on. It is downloaded, never rendered, either way.
 */
function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const utf16 =
    startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
  return utf16 || !bytes.includes(0);
}

/** Images open in the browser; anything else is downloaded, never rendered. */
export function opensInline(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** Control, zero-width and text-direction characters. */
const UNSAFE_IN_NAMES =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A name to show and download a file as: no path, no control, zero-width or
 * direction characters, and the extension of the type that was checked, so
 * a text file cannot be saved as `.bat`. At most FILE_NAME_MAX_LENGTH. Null
 * when nothing of the name is left.
 */
export function cleanFileName(
  name: string | undefined,
  contentType: string,
): string | null {
  if (!name) return null;
  const extension = `.${extensionOf(contentType)}`;
  let base = (name.split(/[\\/]/).pop() ?? '')
    .replace(UNSAFE_IN_NAMES, '')
    .trim();
  let end = base.length;
  while (end > 0 && (base[end - 1] === '.' || base[end - 1] === ' ')) end--;
  base = base.slice(0, end);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .trimEnd()
    .slice(0, FILE_NAME_MAX_LENGTH - extension.length);
  return stem === '' || stem === '.' ? null : `${stem}${extension}`;
}

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
