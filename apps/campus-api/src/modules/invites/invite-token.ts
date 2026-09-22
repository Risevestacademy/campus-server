import { createHash, randomBytes } from 'node:crypto';

/** Raw (unhashed) invite token handed to the invitee. Never persisted. */
export function generateInviteToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hex digest stored in INVITES.token_hash.
 * Hex (64 chars) fits the varchar(128) column with room for algorithm upgrades.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Shareable link embedding the raw token. The hash alone can never be redeemed. */
export function buildInviteLink(baseUrl: string, rawToken: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/invite?token=${encodeURIComponent(rawToken)}`;
}
