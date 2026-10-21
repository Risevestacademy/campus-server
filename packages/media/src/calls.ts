import { randomUUID } from 'node:crypto';
import {
  RoomServiceClient,
  TrackType,
  WebhookReceiver,
} from 'livekit-server-sdk';

import { assertMediaCredentials, type MediaCredentials } from './room-token.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPACE_ROOM = /^space:([^:]+):([^:]+)$/;

/** The call a cohort holds in one space: every cohort has its own. */
export interface SpaceRoom {
  cohortId: string;
  spaceId: string;
}

export function spaceRoomName({ cohortId, spaceId }: SpaceRoom): string {
  if (!UUID.test(cohortId) || !UUID.test(spaceId)) {
    throw new RangeError('a space room is named by two uuids');
  }
  return `space:${cohortId}:${spaceId}`;
}

/** Null for a room that is not a space's call, such as a connection check. */
export function parseSpaceRoomName(name: string): SpaceRoom | null {
  const match = SPACE_ROOM.exec(name);
  if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) {
    return null;
  }
  return { cohortId: match[1].toLowerCase(), spaceId: match[2].toLowerCase() };
}

/**
 * A fresh identity for each time somebody enters a space's call, so that
 * removing them from a call they left cannot remove them from one they have
 * walked back into since.
 */
export function participantIdentity(userId: string): string {
  return `${userId}:${randomUUID()}`;
}

export function userIdOfIdentity(identity: string): string | null {
  const userId = identity.split(':')[0] ?? '';
  return UUID.test(userId) ? userId.toLowerCase() : null;
}

function apiHost(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

/**
 * Takes participants out of rooms, with one client for the key pair. A room
 * or participant already gone is not an error.
 */
export function participantRemover(
  credentials: MediaCredentials,
): (room: string, identity: string) => Promise<void> {
  assertMediaCredentials(credentials);
  const client = new RoomServiceClient(
    apiHost(credentials.url),
    credentials.apiKey,
    credentials.apiSecret,
  );
  return async (room, identity) => {
    try {
      await client.removeParticipant(room, identity);
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return;
      }
      throw err;
    }
  };
}

interface InRoom {
  /** The room's name: a space's call names its cohort and space. */
  room: string;
  /** LiveKit's id for this run of the room: a room emptied and opened again gets a new one. */
  roomId: string;
  /** When LiveKit created this run of the room, to the millisecond. */
  roomOpenedAt: Date;
}

export type CallEvent =
  | (InRoom & { kind: 'room_started' | 'room_finished' })
  | (InRoom & {
      kind: 'participant_joined' | 'participant_left';
      identity: string;
      /** When LiveKit says they joined, if it says. */
      joinedAt: Date | null;
    })
  | (InRoom & {
      kind: 'track_published' | 'track_unpublished';
      identity: string;
      video: boolean;
    });

export interface VerifiedCallEvent {
  /** LiveKit's id for the event, the same on a retry. */
  id: string;
  at: Date;
  /** Null for an event nothing here records. */
  event: CallEvent | null;
}

export class InvalidWebhookError extends Error {}

/** Checks a webhook's signature against the key pair and reads it into plain values. */
export async function verifyCallWebhook(
  keys: Pick<MediaCredentials, 'apiKey' | 'apiSecret'>,
  body: string,
  authorization: string | undefined,
): Promise<VerifiedCallEvent> {
  if (!authorization) {
    throw new InvalidWebhookError('the webhook carries no signature');
  }
  let received;
  try {
    received = await new WebhookReceiver(keys.apiKey, keys.apiSecret).receive(
      body,
      authorization,
    );
  } catch (err) {
    throw new InvalidWebhookError(
      `the webhook could not be verified: ${(err as Error).message}`,
    );
  }

  const at = new Date(Number(received.createdAt) * 1000);
  const room = received.room?.name ?? '';
  const roomId = received.room?.sid ?? '';
  const roomOpenedAt =
    millis(received.room?.creationTimeMs, received.room?.creationTime) ?? at;
  const joinedAt = millis(
    received.participant?.joinedAtMs,
    received.participant?.joinedAt,
  );
  const identity = received.participant?.identity ?? '';
  const event = ((): CallEvent | null => {
    if (!room || !roomId) return null;
    switch (received.event) {
      case 'room_started':
      case 'room_finished':
        return { kind: received.event, room, roomId, roomOpenedAt };
      case 'participant_joined':
      case 'participant_left':
        return identity
          ? {
              kind: received.event,
              room,
              roomId,
              roomOpenedAt,
              identity,
              joinedAt,
            }
          : null;
      case 'track_published':
      case 'track_unpublished':
        return identity
          ? {
              kind: received.event,
              room,
              roomId,
              roomOpenedAt,
              identity,
              video: received.track?.type === TrackType.VIDEO,
            }
          : null;
      default:
        return null;
    }
  })();
  return { id: received.id, at, event };
}

/** A protobuf time as a Date: milliseconds when given, else seconds; null when neither. */
function millis(ms?: bigint, seconds?: bigint): Date | null {
  if (ms) return new Date(Number(ms));
  if (seconds) return new Date(Number(seconds) * 1000);
  return null;
}
