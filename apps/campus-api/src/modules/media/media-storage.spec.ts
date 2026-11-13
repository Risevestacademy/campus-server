import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { r2Connection } from '@campus/media';

import { r2Storage } from './media-storage.js';
import { MediaBucket } from './schema.js';

const client = new S3Client({
  ...r2Connection('0123456789abcdef0123456789abcdef'),
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const storage = r2Storage(client, {
  buckets: {
    [MediaBucket.Public]: 'campus-public',
    [MediaBucket.Private]: 'campus-private',
  },
  publicUrl: 'https://media.campus.test',
});

describe('r2Storage', () => {
  it('signs only the type and size into a PUT to the private bucket', async () => {
    const { url, headers } = await storage.signUpload(
      'incoming/m',
      { contentType: 'image/webp', sizeBytes: 1234 },
      600,
    );
    const parsed = new URL(url);

    expect(parsed.host).toBe(
      '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    );
    expect(parsed.pathname).toBe('/campus-private/incoming/m');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(
      [...parsed.searchParams.keys()].some((k) => /checksum/i.test(k)),
    ).toBe(false);
    expect(headers).toEqual({ 'Content-Type': 'image/webp' });
  });

  it('copies an upload to where it is served, with metadata of its own', async () => {
    const send = vi.spyOn(client, 'send').mockResolvedValueOnce({} as never);

    await storage.copyUpload('incoming/m', {
      bucket: MediaBucket.Public,
      key: 'avatars/u/f.webp',
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const command = send.mock.calls[0][0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'campus-public',
      Key: 'avatars/u/f.webp',
      CopySource: 'campus-private/incoming/m',
      MetadataDirective: 'REPLACE',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    send.mockRestore();
  });

  it('builds public URLs from the configured domain', () => {
    expect(storage.publicUrl('avatars/u/m.webp')).toBe(
      'https://media.campus.test/avatars/u/m.webp',
    );
  });
});
