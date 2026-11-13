import { r2Connection } from '@campus/media';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../../infra/config/env.js';
import { MediaBucket } from './schema.js';

/** R2, behind its own token so tests can stand in for it. */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

export interface UploadTerms {
  contentType: string;
  sizeBytes: number;
}

export interface ServedFile {
  bucket: MediaBucket;
  key: string;
  contentType: string;
  cacheControl?: string;
}

export interface SignedUpload {
  url: string;
  /** What the client must send with the PUT. Content-Length is signed too, but browsers set it. */
  headers: Record<string, string>;
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string | undefined;
}

export interface MediaStorage {
  /** A PUT into the private bucket. */
  signUpload(
    key: string,
    terms: UploadTerms,
    expiresInSeconds: number,
  ): Promise<SignedUpload>;
  /** Null when there is no such object. */
  head(bucket: MediaBucket, key: string): Promise<StoredObject | null>;
  readStart(
    bucket: MediaBucket,
    key: string,
    bytes: number,
  ): Promise<Uint8Array>;
  /** Copies a private upload to where it is served, with the metadata given rather than the client's. */
  copyUpload(uploadKey: string, to: ServedFile): Promise<void>;
  /** A key that is already gone counts as deleted. */
  delete(bucket: MediaBucket, key: string): Promise<void>;
  publicUrl(key: string): string;
}

/** Null unless the R2 variables and the public bucket are all set. */
export function mediaStorageFrom(config: Env): MediaStorage | null {
  const {
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET: privateBucket,
    R2_PUBLIC_BUCKET: publicBucket,
    MEDIA_PUBLIC_URL: publicUrl,
  } = config;
  if (
    !accountId ||
    !accessKeyId ||
    !secretAccessKey ||
    !privateBucket ||
    !publicBucket ||
    !publicUrl
  ) {
    return null;
  }
  const client = new S3Client({
    ...r2Connection(accountId),
    credentials: { accessKeyId, secretAccessKey },
    // The SDK otherwise adds checksum parameters to presigned PUTs, which a
    // browser upload cannot satisfy.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return r2Storage(client, {
    buckets: {
      [MediaBucket.Public]: publicBucket,
      [MediaBucket.Private]: privateBucket,
    },
    publicUrl,
  });
}

export function r2Storage(
  client: S3Client,
  options: { buckets: Record<MediaBucket, string>; publicUrl: string },
): MediaStorage {
  const name = (bucket: MediaBucket) => options.buckets[bucket];
  return {
    async signUpload(key, terms, expiresIn) {
      const command = new PutObjectCommand({
        Bucket: name(MediaBucket.Private),
        Key: key,
        ContentType: terms.contentType,
        ContentLength: terms.sizeBytes,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return { url, headers: { 'Content-Type': terms.contentType } };
    },

    async head(bucket, key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: name(bucket), Key: key }),
        );
        return {
          sizeBytes: head.ContentLength ?? 0,
          contentType: head.ContentType,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readStart(bucket, key, bytes) {
      const object = await client.send(
        new GetObjectCommand({
          Bucket: name(bucket),
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      return object.Body
        ? object.Body.transformToByteArray()
        : new Uint8Array();
    },

    async copyUpload(uploadKey, to) {
      await client.send(
        new CopyObjectCommand({
          Bucket: name(to.bucket),
          Key: to.key,
          CopySource: encodeURI(`${name(MediaBucket.Private)}/${uploadKey}`),
          MetadataDirective: 'REPLACE',
          ContentType: to.contentType,
          CacheControl: to.cacheControl,
        }),
      );
    },

    async delete(bucket, key) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: name(bucket), Key: key }),
        );
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    publicUrl(key) {
      return `${options.publicUrl}/${key}`;
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    (err.name === 'NotFound' ||
      err.name === 'NoSuchKey' ||
      err.$metadata.httpStatusCode === 404)
  );
}
