import {
  mintRoomToken,
  participantIdentity,
  participantRemover,
  spaceRoomName,
} from '@campus/media';

import type { mediaCredentials } from '../../infra/env.js';
import type { CallSpec, Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import type { Doors } from './doors.js';

type CallsContext = Pick<
  WorldContext,
  'app' | 'connections' | 'players' | 'send' | 'isStopping'
>;

export type Calls = ReturnType<typeof createCalls>;

export function createCalls(
  ctx: CallsContext,
  doors: Pick<Doors, 'get'>,
  media: ReturnType<typeof mediaCredentials>,
) {
  const { app, connections, players, send, isStopping } = ctx;
  const removeFromCall = media ? participantRemover(media) : undefined;
  /** Cohorts whose `nearby` lists may be out of date though nobody moved. */
  const nearbyStale = new Set<string>();

  /** The call the space a socket stands in has, or null where it has none. */
  function callFor(connection: Connection): CallSpec | null {
    const space = doors.get(connection.spaceKey);
    if (!space) return null;
    let room: string;
    try {
      room = spaceRoomName({
        cohortId: connection.cohortId,
        spaceId: space.id,
      });
    } catch {
      return null;
    }
    return {
      room,
      hearing: space.audioMode === 'proximity' ? 'proximity' : 'room',
      audibleRadius: space.audibleRadius,
      subscribeRadius: space.subscribeRadius,
    };
  }

  function sameCall(a: CallSpec | null, b: CallSpec | undefined): boolean {
    if (!a || !b) return !a && !b;
    return (
      a.room === b.room &&
      a.hearing === b.hearing &&
      a.audibleRadius === b.audibleRadius &&
      a.subscribeRadius === b.subscribeRadius
    );
  }

  /**
   * Removals LiveKit has not yet confirmed, by room and identity: kept until
   * one succeeds, and tried again at every heartbeat, so somebody who left a
   * room, or lost the right to speak in one, is never left in it.
   */
  const pendingRemovals = new Map<string, { room: string; identity: string }>();
  const removing = new Set<string>();

  /** Takes an identity out of a room, revoking its tokens; retried until LiveKit confirms. */
  function removeFromRoom(room: string, identity: string): void {
    if (!removeFromCall) return;
    const key = `${room}\u0000${identity}`;
    pendingRemovals.set(key, { room, identity });
    if (removing.has(key)) return;
    removing.add(key);
    removeFromCall(room, identity)
      .then(
        () => pendingRemovals.delete(key),
        (err: unknown) => {
          app.log.warn(
            { err, room },
            'could not take somebody out of a room, trying again at the heartbeat',
          );
        },
      )
      .finally(() => removing.delete(key));
  }

  function retryRemovals(): void {
    for (const { room, identity } of pendingRemovals.values()) {
      removeFromRoom(room, identity);
    }
  }

  function leave(connection: Connection): void {
    const call = connection.call;
    if (!call) return;
    connection.call = undefined;
    removeFromRoom(call.room, call.identity);
  }

  /** Hands the socket the call for the space it stands in, after taking it out of the last one. */
  async function join(connection: Connection): Promise<void> {
    if (!media) return;
    leave(connection);
    nearbyStale.add(connection.cohortId);
    const call = callFor(connection);
    if (!call) {
      send(connection.socket, { type: 'call', call: null });
      return;
    }
    const identity = participantIdentity(connection.userId);
    connection.call = { ...call, identity };
    let token;
    try {
      token = await mintRoomToken(media, {
        room: call.room,
        identity,
        name: connection.appearance.displayName ?? undefined,
        canPublish: true,
      });
    } catch (err) {
      app.log.error(
        { err, userId: connection.userId, spaceKey: connection.spaceKey },
        'could not mint a token for a space’s call',
      );
      if (connection.call?.identity === identity) {
        connection.call = undefined;
        if (connections.has(connection)) {
          send(connection.socket, { type: 'call', call: null });
        }
      }
      return;
    }
    // Walked on, or gone, while the token was minted: that call is stale.
    if (connection.call?.identity !== identity || !connections.has(connection))
      return;
    send(connection.socket, {
      type: 'call',
      call: { ...call, url: token.url, token: token.token },
    });
  }

  /** After the spaces are read: a new call for anybody whose space's call is not the one they hold. */
  function refresh(): void {
    if (!media || isStopping()) return;
    for (const connection of connections.all()) {
      if (!sameCall(callFor(connection), connection.call)) {
        void join(connection);
      }
    }
  }

  function markNearbyStale(cohortId: string): void {
    nearbyStale.add(cohortId);
  }

  /** The cohorts marked stale since the last call, emptying the mark. */
  function takeStaleNearby(): Set<string> {
    const stale = new Set(nearbyStale);
    nearbyStale.clear();
    return stale;
  }

  /**
   * Who each person in a proximity space can hear: the others in the same
   * space within its subscribe radius, kept until they are past the radius
   * times its hysteresis, so standing on the line does not flicker. Leaving
   * a proximity space empties the list, and says so.
   */
  function updateNearby(inCohort: readonly Connection[]): void {
    const here = inCohort.flatMap((connection) => {
      const player = players.get(connection);
      return player ? [{ connection, player }] : [];
    });
    for (const { connection, player } of here) {
      const space = doors.get(connection.spaceKey);
      let next = new Set<string>();
      if (space?.audioMode === 'proximity') {
        for (const other of here) {
          if (
            other.connection === connection ||
            other.connection.spaceKey !== connection.spaceKey
          )
            continue;
          const distance = Math.hypot(
            other.player.x - player.x,
            other.player.y - player.y,
          );
          const reach = connection.nearby.has(other.connection.userId)
            ? space.subscribeRadius * space.hysteresisFactor
            : space.subscribeRadius;
          if (distance <= reach) next.add(other.connection.userId);
        }
      } else if (connection.nearby.size === 0) {
        continue;
      } else {
        next = new Set();
      }
      if (
        next.size !== connection.nearby.size ||
        [...next].some((userId) => !connection.nearby.has(userId))
      ) {
        connection.nearby = next;
        send(connection.socket, { type: 'nearby', userIds: [...next].sort() });
      }
    }
  }

  return {
    join,
    leave,
    refresh,
    removeFromRoom,
    retryRemovals,
    markNearbyStale,
    takeStaleNearby,
    updateNearby,
  };
}
