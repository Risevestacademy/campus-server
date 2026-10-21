import { TrackType } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import {
  InvalidWebhookError,
  parseSpaceRoomName,
  participantIdentity,
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
