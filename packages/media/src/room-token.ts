import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Where a media server lives and the key pair that signs for it. Server side
 * only: a client is handed a short-lived room token, never these.
 */
export interface MediaCredentials {
  /** The server clients connect to: `ws://localhost:7880` locally, the Cloud project's `wss://` URL when hosted. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface RoomGrant {
  /** The room to join. Nothing else can be joined with this token. */
  room: string;
  /** Who is joining. The user id, so a participant maps back to an account. */
  identity: string;
  /** What other participants see. */
  name?: string;
  /** False to listen and watch without sending. Subscribing is always allowed. */
  canPublish: boolean;
  ttlSeconds?: number;
}

export interface RoomToken {
  url: string;
  room: string;
  token: string;
  expiresAt: Date;
}

/**
 * Only needed to join: once connected, the server keeps the participant's
 * token fresh itself. Short, so a token that leaks is useless soon after.
 */
export const DEFAULT_ROOM_TOKEN_TTL_SECONDS = 10 * 60;

/** `sessions.provider_room_id` is varchar(128). */
const MAX_ROOM_NAME = 128;

/** LiveKit signs with HMAC; below this a secret is guessable offline. */
const MIN_SECRET_LENGTH = 32;

export class InvalidMediaConfigError extends Error {}

/**
 * Refuses credentials that would only fail later, at the first join — or
 * worse, work with a secret anybody could brute-force from one token.
 */
export function assertMediaCredentials(credentials: MediaCredentials): void {
  if (!/^wss?:\/\//.test(credentials.url)) {
    throw new InvalidMediaConfigError('media url must start with ws:// or wss://');
  }
  if (credentials.apiKey.length === 0) {
    throw new InvalidMediaConfigError('media api key is empty');
  }
  if (credentials.apiSecret.length < MIN_SECRET_LENGTH) {
    throw new InvalidMediaConfigError(
      `media api secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

/**
 * A token to join one room as one person.
 *
 * Audio and video only: `canPublishData` is off, so chat and anything else
 * that is not media goes through world, where it is rate-limited and
 * checked, rather than around it on LiveKit's data channel.
 *
 * This is the only place LiveKit's own types are touched. Callers get plain
 * values back, so the provider stays swappable, as the schema intends
 * (`sessions.provider`).
 */
export async function mintRoomToken(
  credentials: MediaCredentials,
  grant: RoomGrant,
): Promise<RoomToken> {
  assertMediaCredentials(credentials);
  if (grant.room.length === 0 || grant.room.length > MAX_ROOM_NAME) {
    throw new InvalidMediaConfigError(`room name must be 1–${MAX_ROOM_NAME} characters`);
  }
  if (grant.identity.length === 0) {
    throw new InvalidMediaConfigError('identity is empty');
  }

  const ttlSeconds = grant.ttlSeconds ?? DEFAULT_ROOM_TOKEN_TTL_SECONDS;
  // The SDK reads a falsy ttl as "use my default", which is six hours: a 0
  // meant as "expire at once" would quietly become the longest token going.
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new InvalidMediaConfigError(
      'token lifetime must be a positive whole number of seconds',
    );
  }
  const token = new AccessToken(credentials.apiKey, credentials.apiSecret, {
    identity: grant.identity,
    name: grant.name,
    ttl: ttlSeconds,
  });
  token.addGrant({
    roomJoin: true,
    room: grant.room,
    canPublish: grant.canPublish,
    canSubscribe: true,
    canPublishData: false,
  });

  const jwt = await token.toJwt();
  return {
    url: credentials.url,
    room: grant.room,
    token: jwt,
    // Read back from the token rather than recomputed: the SDK stamps `exp`
    // from its own clock, and this must be the moment the server will use.
    expiresAt: new Date(expiryOf(jwt) * 1000),
  };
}

function expiryOf(jwt: string): number {
  const payload = jwt.split('.')[1] ?? '';
  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    exp?: unknown;
  };
  if (typeof exp !== 'number') {
    throw new Error('minted a room token without an expiry');
  }
  return exp;
}

/**
 * A room for the pre-join network check: unique per call, so nobody else can
 * ever be in it, and gone as soon as the check disconnects. Publishing is
 * allowed because the check sends a test track.
 */
export function mintConnectionCheckToken(
  credentials: MediaCredentials,
  identity: string,
): Promise<RoomToken> {
  return mintRoomToken(credentials, {
    room: `connection-check-${randomUUID()}`,
    identity,
    canPublish: true,
    ttlSeconds: 120,
  });
}
