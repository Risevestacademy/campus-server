import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

/**
 * AES-256-GCM, with `context` (the owner's user id) as additional data, so a
 * sealed token copied onto another row does not open.
 */
export function sealToken(
  key: Buffer,
  plaintext: string,
  context: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}

/** Throws when the key, the context or the token itself is not the one sealed. */
export function openToken(
  key: Buffer,
  sealed: string,
  context: string,
): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || body === undefined) {
    throw new Error('not a sealed token');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
