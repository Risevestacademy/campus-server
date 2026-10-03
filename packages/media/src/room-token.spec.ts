import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOM_TOKEN_TTL_SECONDS,
  InvalidMediaConfigError,
  mintConnectionCheckToken,
  mintRoomToken,
  type MediaCredentials,
} from './room-token.js';

const credentials: MediaCredentials = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'a-media-secret-of-at-least-thirty-two-chars',
};

/** What LiveKit itself will read from the token. */
const verify = (token: string, secret = credentials.apiSecret) =>
  new TokenVerifier(credentials.apiKey, secret).verify(token);

describe('mintRoomToken', () => {
  it('lets one person into one room, as themselves', async () => {
    const minted = await mintRoomToken(credentials, {
      room: 'space-lobby',
      identity: 'user-1',
      name: 'Ada',
      canPublish: true,
    });

    const claims = await verify(minted.token);
    expect(claims.sub).toBe('user-1');
    expect(claims.name).toBe('Ada');
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: 'space-lobby',
      canPublish: true,
      canSubscribe: true,
    });
    expect(minted).toMatchObject({ url: credentials.url, room: 'space-lobby' });
  });

  /** Chat goes through world, where it is rate-limited and checked. */
  it('does not open the data channel', async () => {
    const minted = await mintRoomToken(credentials, {
      room: 'r',
      identity: 'user-1',
      canPublish: true,
    });

    expect((await verify(minted.token)).video?.canPublishData).toBe(false);
  });

  it('grants no room administration', async () => {
    const minted = await mintRoomToken(credentials, {
      room: 'r',
      identity: 'user-1',
      canPublish: true,
    });

    const { video } = await verify(minted.token);
    for (const power of [
      'roomCreate',
      'roomAdmin',
      'roomList',
      'roomRecord',
      'hidden',
    ]) {
      expect(video?.[power as keyof typeof video]).toBeFalsy();
    }
  });

  it('can let somebody listen without sending', async () => {
    const minted = await mintRoomToken(credentials, {
      room: 'r',
      identity: 'user-1',
      canPublish: false,
    });

    expect((await verify(minted.token)).video).toMatchObject({
      canPublish: false,
      canSubscribe: true,
    });
  });

  it('expires after ten minutes by default, and says exactly when', async () => {
    const before = Date.now();
    const minted = await mintRoomToken(credentials, {
      room: 'r',
      identity: 'user-1',
      canPublish: true,
    });

    const { exp } = await verify(minted.token);
    expect(minted.expiresAt.getTime()).toBe((exp as number) * 1000);
    const ttl = minted.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan((DEFAULT_ROOM_TOKEN_TTL_SECONDS - 2) * 1000);
    expect(ttl).toBeLessThanOrEqual(DEFAULT_ROOM_TOKEN_TTL_SECONDS * 1000);
  });

  it('is refused by a server holding a different secret', async () => {
    const minted = await mintRoomToken(credentials, {
      room: 'r',
      identity: 'user-1',
      canPublish: true,
    });

    await expect(
      verify(minted.token, 'a-different-secret-of-at-least-thirty-two'),
    ).rejects.toThrow();
  });

  describe('refuses configuration that would only fail later', () => {
    const grant = { room: 'r', identity: 'user-1', canPublish: true };

    it('a secret short enough to guess', async () => {
      await expect(
        mintRoomToken({ ...credentials, apiSecret: 'devsecret' }, grant),
      ).rejects.toThrow(InvalidMediaConfigError);
    });

    it('a url a client cannot connect to', async () => {
      await expect(
        mintRoomToken(
          { ...credentials, url: 'https://example.livekit.cloud' },
          grant,
        ),
      ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    });

    it('a missing api key', async () => {
      await expect(
        mintRoomToken({ ...credentials, apiKey: '' }, grant),
      ).rejects.toThrow(InvalidMediaConfigError);
    });

    it('an empty or overlong room name', async () => {
      await expect(
        mintRoomToken(credentials, { ...grant, room: '' }),
      ).rejects.toThrow(InvalidMediaConfigError);
      await expect(
        mintRoomToken(credentials, { ...grant, room: 'x'.repeat(129) }),
      ).rejects.toThrow(InvalidMediaConfigError);
    });

    /** The SDK would turn 0 into its six-hour default. */
    it('a lifetime that is not a positive whole number of seconds', async () => {
      for (const ttlSeconds of [0, -60, 1.5, Number.NaN]) {
        await expect(
          mintRoomToken(credentials, { ...grant, ttlSeconds }),
        ).rejects.toThrow(InvalidMediaConfigError);
      }
    });

    it('nobody to join as', async () => {
      await expect(
        mintRoomToken(credentials, { ...grant, identity: '' }),
      ).rejects.toThrow(InvalidMediaConfigError);
    });
  });
});

describe('mintConnectionCheckToken', () => {
  /** Unique rooms, so a check never lands in somebody else's. */
  it('puts every check in a room of its own', async () => {
    const one = await mintConnectionCheckToken(credentials, 'user-1');
    const two = await mintConnectionCheckToken(credentials, 'user-1');

    expect(one.room).toMatch(/^connection-check-/);
    expect(one.room).not.toBe(two.room);
  });

  it('lets the check publish a test track, and expires within two minutes', async () => {
    const minted = await mintConnectionCheckToken(credentials, 'user-1');

    expect((await verify(minted.token)).video).toMatchObject({
      room: minted.room,
      canPublish: true,
    });
    expect(minted.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      120_000,
    );
  });
});
