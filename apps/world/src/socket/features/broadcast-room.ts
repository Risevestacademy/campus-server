import {
  broadcastRoomName,
  mintRoomToken,
  participantIdentity,
} from '@campus/media';
import { hasAdminPowers } from '@campus/session';

import type { mediaCredentials } from '../../infra/env.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';

type BroadcastRoomContext = Pick<WorldContext, 'app' | 'connections' | 'send'>;

/**
 * How long a token that may speak in the broadcast room lasts. Only for
 * joining, as LiveKit keeps a connected participant's token fresh itself;
 * short, so an admin who stops being one cannot rejoin with it and speak.
 */
const SPEAKING_TOKEN_TTL_SECONDS = 60;

export function createBroadcastRoom(
  ctx: BroadcastRoomContext,
  media: ReturnType<typeof mediaCredentials>,
  removeFromRoom: (room: string, identity: string) => void,
) {
  const { app, connections, send } = ctx;
  /** Sockets whose broadcast token could not be minted: the heartbeat tries again. */
  const missing = new WeakSet<Connection>();

  function leave(connection: Connection): void {
    const broadcast = connection.broadcast;
    if (!broadcast) return;
    connection.broadcast = undefined;
    removeFromRoom(broadcast.room, broadcast.identity);
  }

  /**
   * Hands the socket its cohort's broadcast room, beside the space's call:
   * admins may speak there, microphone only; everybody else listens.
   */
  async function join(connection: Connection): Promise<void> {
    if (!media) return;
    missing.delete(connection);
    leave(connection);
    let room: string;
    try {
      room = broadcastRoomName(connection.cohortId);
    } catch {
      send(connection.socket, { type: 'broadcast', call: null });
      return;
    }
    const canSpeak = hasAdminPowers(connection.systemRole);
    const identity = participantIdentity(connection.userId);
    connection.broadcast = { room, identity, canSpeak };
    let token;
    try {
      token = await mintRoomToken(media, {
        room,
        identity,
        name: connection.appearance.displayName ?? undefined,
        canPublish: canSpeak,
        audioOnly: true,
        ttlSeconds: canSpeak ? SPEAKING_TOKEN_TTL_SECONDS : undefined,
      });
    } catch (err) {
      app.log.error(
        { err, userId: connection.userId },
        'could not mint a token for the broadcast room',
      );
      if (connection.broadcast?.identity === identity) {
        connection.broadcast = undefined;
        if (connections.has(connection)) {
          missing.add(connection);
          send(connection.socket, { type: 'broadcast', call: null });
        }
      }
      return;
    }
    if (
      connection.broadcast?.identity !== identity ||
      !connections.has(connection)
    )
      return;
    send(connection.socket, {
      type: 'broadcast',
      call: { url: token.url, room, token: token.token, canSpeak },
    });
  }

  function isMissing(connection: Connection): boolean {
    return missing.has(connection);
  }

  return { join, leave, isMissing };
}
