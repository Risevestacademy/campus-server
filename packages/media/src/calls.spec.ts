import { TrackType } from 'livekit-server-sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  InvalidWebhookError,
  broadcastRoomName,
  parseSpaceRoomName,
  participantIdentity,
  microphoneMuter,
  participantRemover,
  spaceRoomName,
  userIdOfIdentity,
  verifyCallWebhook,
} from './calls.js';
import { signCallWebhook } from './testing.js';

const COHORT = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const KEYS = { apiKey: 'webhook-key', apiSecret: 'w'.repeat(32) };

async function signed(event: object, keys = KEYS) {
  const body = JSON.stringify(event);
  return { body, authorization: await signCallWebhook(keys, body) };
}

describe('space room names', () => {
  it('names a cohort’s call in a space, and reads it back', () => {
    const name = spaceRoomName({ cohortId: COHORT, spaceId: SPACE });

    expect(parseSpaceRoomName(name)).toEqual({
      cohortId: COHORT,
      spaceId: SPACE,
    });
  });

  it('reads no space from a room that is not a space’s call', () => {
    expect(parseSpaceRoomName('connection-check-abc')).toBeNull();
    expect(parseSpaceRoomName(`space:${COHORT}:not-a-uuid`)).toBeNull();
  });

  it('refuses to name a room from anything but ids', () => {
    expect(() => spaceRoomName({ cohortId: 'c1', spaceId: SPACE })).toThrow();
  });
});

describe('broadcast room names', () => {
  it('names one per cohort, which no space’s call can be mistaken for', () => {
    const name = broadcastRoomName(COHORT);

    expect(name).toBe(`broadcast:${COHORT}`);
    expect(parseSpaceRoomName(name)).toBeNull();
  });

  it('refuses to name a room from anything but a cohort id', () => {
    expect(() => broadcastRoomName('c1')).toThrow();
  });
});

describe('participant identities', () => {
  it('gives a fresh identity each time, and the user it belongs to', () => {
    const first = participantIdentity(USER);
    const second = participantIdentity(USER);

    expect(first).not.toBe(second);
    expect(userIdOfIdentity(first)).toBe(USER);
  });

  it('reads no user from an identity that does not start with one', () => {
    expect(userIdOfIdentity('somebody')).toBeNull();
  });
});

describe('verifying a webhook', () => {
  const room = spaceRoomName({ cohortId: COHORT, spaceId: SPACE });

  it('reads a participant joining, with LiveKit’s times to the millisecond', async () => {
    const { body, authorization } = await signed({
      event: 'participant_joined',
      id: 'EV_1',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1', creationTimeMs: '1792499990123' },
      participant: { identity: `${USER}:x`, joinedAtMs: '1792499999456' },
    });

    await expect(verifyCallWebhook(KEYS, body, authorization)).resolves.toEqual(
      {
        id: 'EV_1',
        at: new Date(1792500000 * 1000),
        event: {
          kind: 'participant_joined',
          room,
          roomId: 'RM_1',
          roomOpenedAt: new Date(1792499990123),
          identity: `${USER}:x`,
          joinedAt: new Date(1792499999456),
        },
      },
    );
  });

  it('falls back to the event’s time for a room LiveKit gives no creation time', async () => {
    const { body, authorization } = await signed({
      event: 'room_started',
      id: 'EV_6',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1' },
    });

    await expect(
      verifyCallWebhook(KEYS, body, authorization),
    ).resolves.toMatchObject({
      event: { roomOpenedAt: new Date(1792500000 * 1000) },
    });
  });

  it('says whether a published track is video', async () => {
    const { body, authorization } = await signed({
      event: 'track_published',
      id: 'EV_2',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1' },
      participant: { identity: `${USER}:x` },
      track: { type: TrackType[TrackType.VIDEO] },
    });

    await expect(
      verifyCallWebhook(KEYS, body, authorization),
    ).resolves.toMatchObject({
      event: { kind: 'track_published', video: true },
    });
  });

  it('passes a room event without LiveKit’s id for the room as null', async () => {
    const { body, authorization } = await signed({
      event: 'room_started',
      id: 'EV_5',
      createdAt: '1792500000',
      room: { name: room },
    });

    await expect(
      verifyCallWebhook(KEYS, body, authorization),
    ).resolves.toMatchObject({ event: null });
  });

  it('passes an event nothing records as null', async () => {
    const { body, authorization } = await signed({
      event: 'egress_started',
      id: 'EV_3',
      createdAt: '1792500000',
    });

    await expect(
      verifyCallWebhook(KEYS, body, authorization),
    ).resolves.toMatchObject({ event: null });
  });

  it('refuses a body signed with another secret, a changed body, and no signature', async () => {
    const event = {
      event: 'room_started',
      id: 'EV_4',
      createdAt: '1792500000',
      room: { name: room, sid: 'RM_1' },
    };
    const forged = await signed(event, {
      apiKey: KEYS.apiKey,
      apiSecret: 'x'.repeat(32),
    });
    const genuine = await signed(event);

    await expect(
      verifyCallWebhook(KEYS, forged.body, forged.authorization),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
    await expect(
      verifyCallWebhook(
        KEYS,
        genuine.body.replace('room_started', 'room_finished'),
        genuine.authorization,
      ),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
    await expect(
      verifyCallWebhook(KEYS, genuine.body, undefined),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
  });
});

describe('participantRemover', () => {
  /** Stands in for LiveKit's server API, answering each RemoveParticipant with `status`. */
  async function livekit(status = 200) {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          status === 200 ? '{}' : '{"code":"internal","msg":"down"}',
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const remove = participantRemover(
      {
        url: `ws://127.0.0.1:${port}`,
        apiKey: 'devkey',
        apiSecret: 'a-livekit-secret-of-at-least-32-chars',
      },
      () => 1_700_000_000_500,
    );
    return {
      bodies,
      remove,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('revokes the identity’s tokens as it removes them, this second’s included', async () => {
    const api = await livekit();

    await api.remove('broadcast:room', 'user:abc');

    expect(api.bodies).toEqual([
      {
        room: 'broadcast:room',
        identity: 'user:abc',
        revokeTokenTs: '1700000001',
      },
    ]);
    await api.close();
  });

  it('treats somebody already gone as removed', async () => {
    const api = await livekit(404);

    await expect(api.remove('r', 'user:abc')).resolves.toBeUndefined();
    await api.close();
  });

  it('fails when LiveKit cannot remove them, so the caller can try again', async () => {
    const api = await livekit(500);

    await expect(api.remove('r', 'user:abc')).rejects.toThrow();
    await api.close();
  });
});

describe('microphoneMuter', () => {
  /** Stands in for LiveKit's server API: one participant, with these tracks. */
  async function livekit(tracks: Record<string, unknown>[], found = true) {
    const muted: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const json = JSON.parse(body) as Record<string, unknown>;
        if (request.url?.endsWith('/GetParticipant')) {
          if (!found) {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{"code":"not_found","msg":"gone"}');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ identity: json.identity, tracks }));
          return;
        }
        muted.push(json);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sid: json.trackSid, muted: true }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const mute = microphoneMuter({
      url: `ws://127.0.0.1:${port}`,
      apiKey: 'devkey',
      apiSecret: 'a-livekit-secret-of-at-least-32-chars',
    });
    return {
      muted,
      mute,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('mutes the microphone that is on, and nothing else', async () => {
    const api = await livekit([
      { sid: 'TR_mic', source: 'MICROPHONE', type: 'AUDIO', muted: false },
      { sid: 'TR_cam', source: 'CAMERA', type: 'VIDEO', muted: false },
      { sid: 'TR_screen', source: 'SCREEN_SHARE', type: 'VIDEO', muted: false },
    ]);

    await expect(api.mute('space:room', 'user:abc')).resolves.toBe(true);

    expect(api.muted).toEqual([
      {
        room: 'space:room',
        identity: 'user:abc',
        trackSid: 'TR_mic',
        muted: true,
      },
    ]);
    await api.close();
  });

  it('says so when there was no microphone on', async () => {
    const api = await livekit([
      { sid: 'TR_mic', source: 'MICROPHONE', type: 'AUDIO', muted: true },
    ]);

    await expect(api.mute('r', 'user:abc')).resolves.toBe(false);
    expect(api.muted).toEqual([]);
    await api.close();
  });

  it('says so when nobody by that identity is in the room', async () => {
    const api = await livekit([], false);

    await expect(api.mute('r', 'user:abc')).resolves.toBe(false);
    await api.close();
  });
});
