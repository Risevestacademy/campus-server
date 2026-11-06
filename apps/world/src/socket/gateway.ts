import { DEFAULT_SPACE_KEY } from '@campus/session';
import { SPACE_ACCESS, mayEnter } from '@campus/space-access';
import type { FastifyInstance } from 'fastify';

import { type AccountLookup } from '../infra/accounts.js';
import { mediaCredentials, type Env } from '../infra/env.js';
import { worldMetrics } from '../infra/metrics.js';
import type { PositionStore } from '../infra/positions.js';
import type { PresenceStore } from '../infra/presence.js';
import { nearestWalkable, walkable, type Tile } from '../movement/grid.js';
import { Players } from '../movement/players.js';
import { spaceAt } from '../movement/spaces.js';
import { assertWorldMap, type WorldMap } from '../movement/world-map.js';
import { seatKey, type Seat } from '../seat.js';
import {} from './authenticate.js';
import { Connections, personOf, type Connection } from './connections.js';
import { createContext } from './context.js';
import { createAppearance } from './features/appearance.js';
import { createBroadcastRoom } from './features/broadcast-room.js';
import { createCalls } from './features/calls.js';
import { createChat } from './features/chat.js';
import { createDoors } from './features/doors.js';
import { createEntryRequests } from './features/entry-requests.js';
import { createLocks } from './features/locks.js';
import { createModeration } from './features/moderation.js';
import { createMoves } from './features/moves.js';
import { createPositions } from './features/positions.js';
import { createPresence } from './features/presence.js';
import { createSweeps } from './features/sweeps.js';
import { createWalks } from './features/walks.js';
import { createDispatch } from './dispatch.js';
import { registerSocketRoute } from './open-connection.js';
import { encode } from './protocol.js';

export interface Gateway {
  connections: Connections;
  players: Players;
  /**
   * campus-api says this account's sprite or display name changed: read it
   * again, and tell their cohort if what to draw is different.
   */
  appearanceChanged(userId: string): Promise<void>;
  /**
   * campus-api says something a space's door reads has changed: read every
   * space on the map again. Resolves once the doors answer from it.
   */
  spacesChanged(): Promise<void>;
  /**
   * campus-api says this map key was published. Reloads the map if it is
   * still the entry map the database names; a key world does not serve is
   * logged and ignored.
   */
  mapPublished(mapKey: string): Promise<void>;
  /**
   * Re-reads which entry map is published and reloads it when it differs
   * from what is running. Called when the database notification channel
   * (re)subscribes, so a publish missed while world was down is caught.
   */
  publishedMapChanged(): Promise<void>;
  /**
   * campus-api says who holds a desk may have changed, in one cohort or, with
   * null, in every cohort: tell the people there to fetch the desks again.
   */
  desksChanged(cohortId: string | null): void;
  stop(): Promise<void>;
  /**
   * Stops the gauges reading the sockets, for a test that builds world more
   * than once in a process. Not part of stop(), so the final flush still
   * reads the last counts; a deployed world exits after that flush, so it
   * never needs this.
   */
  dispose(): void;
}

export function registerGateway(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
  positions: PositionStore,
  presence: PresenceStore,
  map: WorldMap,
  /** The same startup loading path, for a publish that happens later. */
  loadMap: (mapKey: string) => Promise<WorldMap>,
): Gateway {
  const connections = new Connections();
  const metrics = worldMetrics(connections);
  let stopping = false;

  const players = new Players(
    map.grid,
    env.WORLD_STEP_MS,
    env.WORLD_RECONNECT_GRACE_SECONDS * 1000,
  );
  const ctx = createContext({
    app,
    env,
    map,
    connections,
    players,
    metrics,
    isStopping: () => stopping,
  });
  const { send, sendFrame, broadcast, closeFor } = ctx;
  const appearance = createAppearance(ctx, accounts);

  const doors = createDoors(ctx, accounts, afterSpacesRead);
  const locks = createLocks(ctx, doors, (cohortId, spaceKey) =>
    requests.review(cohortId, spaceKey),
  );

  function afterSpacesRead(): void {
    calls.refresh();
    locks.refreshLockable();
    doors.refreshNames();
    requests.review();
  }

  /**
   * Whether this socket's person may step into a space, at `now`. The map's
   * default space is the way to everywhere else and the database keeps it
   * normal, so it is never asked about.
   */
  function mayStepInto(
    connection: Connection,
    spaceKey: string,
    now: Date,
  ): boolean {
    if (spaceKey === DEFAULT_SPACE_KEY) {
      return true;
    }
    if (moderation.isRemoved(connection, spaceKey, now.getTime())) {
      return false;
    }
    const space = doors.factsFor(spaceKey);
    // A pass gets past the list and a lock, never the rest of the door.
    if (doors.holdsRoomLinkPass(connection, spaceKey, now)) {
      return mayEnter(
        personOf(connection),
        { ...space, access: SPACE_ACCESS.Normal, locked: false },
        now,
      );
    }
    return mayEnter(
      personOf(connection),
      locks.isLocked(connection.cohortId, spaceKey)
        ? { ...space, locked: true }
        : space,
      now,
    );
  }

  const requests = createEntryRequests(ctx, {
    doors,
    locks,
    isRemoved: (connection, spaceKey, now) =>
      moderation.isRemoved(connection, spaceKey, now),
    mayStepInto,
  });

  const media = mediaCredentials(env);
  const chat = createChat(ctx, doors.get);
  const calls = createCalls(ctx, doors, media);
  const broadcastRoom = createBroadcastRoom(ctx, media, calls.removeFromRoom);
  const moderation = createModeration(ctx, {
    doors,
    requests,
    media,
    mayStepInto,
    movedOut(target, player) {
      noteMoved(target);
      arrivedAt(target, player);
      walks.end(target, 'moved_by_staff');
    },
  });
  const walks = createWalks(ctx, {
    presence,
    readRoomLinkPasses: doors.readRoomLinkPasses,
    requests,
    mayStepInto,
    noteMoved,
    arrivedAt,
  });

  /** Turned or moved: the next tick sends it, and the next save keeps it. */
  function noteMoved(connection: Connection): void {
    // The two fields copied out, not the connection: these maps outlive the
    // socket, and holding it would keep it in memory.
    const seat: Seat = {
      userId: connection.userId,
      cohortId: connection.cohortId,
    };
    moves.moved(seat);
    positionWrites.moved(seat);
  }

  /** On a new tile: maybe in another space, maybe away from a door. */
  function arrivedAt(connection: Connection, tile: Tile): void {
    recordSpaceCrossing(connection, tile);
    requests.leaveTheDoor(connection, tile);
  }

  const moves = createMoves(ctx, calls, media !== undefined);

  const positionWrites = createPositions(ctx, positions);

  /**
   * After a move to `tile`: if it is in another space, tells the cohort and
   * records the new one in presence now, not at the next renewal. Skipped
   * once shutdown has begun, as the write would undo shutdown's removal.
   */
  function recordSpaceCrossing(connection: Connection, tile: Tile): void {
    const spaceKey = spaceAt(map.spaces, tile);
    if (spaceKey === connection.spaceKey) return;
    const left = connection.spaceKey;
    connection.spaceKey = spaceKey;
    if (stopping) return;
    broadcast(connection.cohortId, {
      type: 'spaceChanged',
      userId: connection.userId,
      spaceKey,
    });
    locks.unlockIfEmpty(connection.cohortId, left);
    requests.review(connection.cohortId, left);
    requests.review(connection.cohortId, spaceKey);
    void calls.join(connection);
    presenceSync.changeSpace(connection);
  }

  const presenceSync = createPresence(ctx, presence, drop);

  /**
   * A reload in flight, and the latest key asked for while it runs. One at a
   * time, as the doors read: two quick publishes end with the later map
   * served, and a notification during a reload is not lost.
   */
  let reloading: Promise<void> | undefined;
  let reloadAgain = false;
  let pendingKey: string | undefined;

  /**
   * The map is built and validated before this runs. Everything here is
   * synchronous: no socket handler can run between the swap and the end of
   * the player fix-up, so nobody steps onto a tile being reassigned.
   */
  function applyWorldMap(next: WorldMap): void {
    if (next.id === map.id && next.version === map.version) return;

    map.id = next.id;
    map.version = next.version;
    map.grid = next.grid;
    map.spaces = next.spaces;
    players.setGrid(next.grid);

    const mapChanged = encode({
      type: 'mapChanged',
      map: {
        id: map.id,
        version: map.version,
        width: map.grid.width,
        height: map.grid.height,
      },
    });
    for (const connection of connections.everyone()) {
      sendFrame(connection.socket, mapChanged);
    }

    // Paths were found against the old walls. The walks keep their targets
    // and find the way again from where the people now stand.
    walks.replanAll();
    fixPlayers();

    // Derived from the map: names, lockable spaces and calls. A read of the
    // spaces themselves is started too, for a map whose key moved.
    calls.refresh();
    locks.refreshLockable();
    doors.refreshNames();
    requests.review();
    void doors.reload();
  }

  /**
   * Everybody still connected, against the new map: off a tile that became a
   * wall, then into the space that tile is in now. A nudge is sent to the
   * person it happened to and, as ordinary news, to the rest of the cohort.
   */
  function fixPlayers(): void {
    for (const connection of connections.all()) {
      const player = players.get(connection);
      if (!player) continue;

      let at = player;
      if (!walkable(map.grid, at)) {
        const nearest =
          nearestWalkable(map.grid, at) ??
          (walkable(map.grid, map.grid.spawn) ? map.grid.spawn : undefined);
        if (!nearest) {
          app.log.error(
            {
              userId: connection.userId,
              cohortId: connection.cohortId,
              x: at.x,
              y: at.y,
            },
            'new map leaves a player with no walkable tile; leaving them where they stand',
          );
          continue;
        }
        const placed = players.place(connection, nearest);
        if (!placed) {
          app.log.error(
            { userId: connection.userId, cohortId: connection.cohortId },
            'could not move a player off a wall on the new map',
          );
          continue;
        }
        at = placed;
        send(connection.socket, { type: 'positionCorrected', player: at });
        // Watchers see the map change, but not moves: the tick sends those to
        // avatar holders only, and a correction is a move.
        const moved = encode({ type: 'moved', players: [at] });
        for (const other of connections.all()) {
          if (other.cohortId === connection.cohortId && other !== connection) {
            sendFrame(other.socket, moved);
          }
        }
        positionWrites.moved(connection);
        // The nudge changed where somebody stands without a step, so the tick
        // has no move of theirs to notice. Say the cohort's lists are stale.
        calls.markNearbyStale(connection.cohortId);
      }

      const spaceKey = spaceAt(map.spaces, at);
      if (spaceKey !== connection.spaceKey) {
        arrivedAt(connection, at);
      }
    }
  }

  /**
   * Reads and builds the map before anything live is touched. A failure of
   * any kind leaves the old map serving and is logged; world does not crash
   * for a bad publish.
   */
  async function reloadMap(mapKey: string): Promise<void> {
    try {
      const next = await loadMap(mapKey);
      assertWorldMap(next);
      applyWorldMap(next);
    } catch (err) {
      app.log.error(
        { err, mapKey },
        'could not reload the published map; keeping the one running',
      );
    }
  }

  function requestReload(mapKey: string): Promise<void> {
    pendingKey = mapKey;
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = (async () => {
      do {
        reloadAgain = false;
        const key = pendingKey;
        pendingKey = undefined;
        if (key !== undefined) await reloadMap(key);
      } while (reloadAgain);
    })().finally(() => {
      reloading = undefined;
    });
    return reloading;
  }

  async function mapPublished(mapKey: string): Promise<void> {
    if (typeof mapKey !== 'string' || mapKey.length === 0) return;
    try {
      const published = await accounts.publishedEntryMapKey();
      if (published !== mapKey) {
        app.log.warn(
          { mapKey, published },
          'ignoring a map notification for a key world does not serve',
        );
        return;
      }
    } catch (err) {
      app.log.error(
        { err, mapKey },
        'could not check which map is published; keeping the one running',
      );
      return;
    }
    await requestReload(mapKey);
  }

  async function publishedMapChanged(): Promise<void> {
    try {
      const published = await accounts.publishedEntryMapKey();
      if (published === null) return;
      await requestReload(published);
    } catch (err) {
      app.log.error(
        { err },
        'could not check which map is published; keeping the one running',
      );
    }
  }

  /**
   * Every way a socket stops counting goes through here, so a player can
   * never outlive the socket standing for them. Idempotent: a socket dropped
   * by the heartbeat comes back through here from its close event, and a
   * displaced one finds its replacement already holding the account's place
   * in that cohort.
   *
   * Where they stood is remembered for the reconnect grace, unless `remember`
   * is false — for access taken away, where a reconnect would be refused
   * anyway and there is nothing to come back to. The avatar leaves everybody
   * else's screen either way: a frozen stand-in for somebody who may never
   * return is worse than a flicker for somebody who does.
   */
  function drop(connection: Connection, remember = true): void {
    if (connection.mode === 'watcher') {
      connections.removeWatcher(connection);
      chat.forget(connection);
      // Access taken away reaches the avatar kept for a reconnect, and the
      // saved position, through whichever socket is still open: here, only
      // a watcher. A live avatar is its own socket's to drop.
      if (!remember && !connections.holderOf(connection)) {
        players.leave(connection, Date.now(), false);
        positionWrites.forget(connection);
      }
      return;
    }
    walks.cancel(connection);
    presenceSync.forgetStatusTimer(connection);
    // A redeploy closes every socket, but LiveKit keeps running: calls are
    // left to the clients, which reconnect and are handed new ones.
    if (!stopping) {
      calls.leave(connection);
      broadcastRoom.leave(connection);
    }
    calls.markNearbyStale(connection.cohortId);
    // A connection displaced here no longer holds the account's presence;
    // after shutdown began, everybody has been removed already.
    if (connections.has(connection) && !stopping) {
      presenceSync.leave([connection]);
    }
    // A replaced socket's request and yes were ended at the swap, and the
    // seat is the new socket's now: a late close must not touch them.
    const held = connections.has(connection);
    connections.remove(connection);
    if (!stopping) {
      locks.unlockIfEmpty(connection.cohortId, connection.spaceKey);
      if (held) {
        requests.left(connection);
      }
      requests.review(connection.cohortId, connection.spaceKey);
    }
    // Replaced in the same cohort: the avatar stays, and the new socket
    // stands for it. Their places in other cohorts are none of this.
    if (connections.holderOf(connection)) {
      return;
    }
    const seat = seatKey(connection);
    const standing = players.get(connection);
    if (players.leave(connection, Date.now(), remember, connection.id)) {
      // With them goes any step of theirs the tick has not sent yet: should
      // they be back before it runs, `joined` already says where they stand.
      moves.forget(seat);
      broadcast(connection.cohortId, {
        type: 'left',
        userId: connection.userId,
      });
    }
    // Kept for the next visit only when they may come back; after shutdown
    // began, everybody has been written already. Access taken away forgets
    // this connection's cohort: there is nothing to come back to.
    if (!remember) {
      positionWrites.forget(connection);
    } else if (standing && !stopping) {
      positionWrites.left(standing, connection.cohortId);
    }
    chat.forget(connection);
  }

  /**
   * A socket that entered ifFree, displaced by one that took its place: it
   * keeps watching rather than closing. Its request and pass were ended at
   * the swap, as for any socket replaced.
   */
  function demote(connection: Connection): void {
    walks.cancel(connection);
    presenceSync.forgetStatusTimer(connection);
    calls.leave(connection);
    broadcastRoom.leave(connection);
    connection.nearby = new Set();
    calls.markNearbyStale(connection.cohortId);
    connection.mode = 'watcher';
    connections.addWatcher(connection);
    ctx.send(connection.socket, { type: 'watching' });
  }

  const sweeps = createSweeps(ctx, accounts, {
    appearance,
    broadcastRoom,
    requests,
    drop,
  });

  const heartbeat = setInterval(() => {
    sweeps.run();
    void doors.reload();
    if (!stopping) calls.retryRemovals();
    const now = Date.now();
    players.forgetExpired(now);
    for (const connection of connections.everyone()) {
      // A socket that names no login has only its access token to go on, so
      // it lasts exactly as long as that token does — otherwise signing out,
      // or simply waiting, would leave the campus open with nothing to end
      // it. A socket that names one follows the login (dropEndedSessions).
      if (
        connection.sessionId === undefined &&
        connection.expiresAt.getTime() <= now
      ) {
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'session expired, closing socket',
        );
        // Dropped from the registry here rather than when the close event
        // comes back, so nothing is counted as present once we have decided
        // it is not. Removal is idempotent, so the close handler is fine.
        drop(connection);
        closeFor(connection.socket, 'session_expired');
        continue;
      }

      if (!connection.alive) {
        // Missed the last round trip: the socket is open as far as this
        // process knows, and gone as far as anybody else is concerned.
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'socket failed heartbeat, closing',
        );
        drop(connection);
        metrics.closedByServer('heartbeat_missed');
        connection.socket.terminate();
        continue;
      }
      if (connection.mode === 'avatar') presenceSync.checkIdle(connection, now);
      connection.alive = false;
      connection.socket.ping();
    }
  }, env.WORLD_HEARTBEAT_SECONDS * 1000);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  const listen = createDispatch(ctx, {
    presence: presenceSync,
    locks,
    requests,
    chat,
    moderation,
    walks,
    drop,
    noteMoved,
    arrivedAt,
  });
  registerSocketRoute(ctx, {
    accounts,
    positions,
    positionWrites,
    doors,
    locks,
    appearance,
    requests,
    presence: presenceSync,
    presenceStore: presence,
    calls,
    broadcastRoom,
    mayStepInto,
    drop,
    demote,
    listen,
  });

  return {
    connections,
    players,
    appearanceChanged: appearance.changed,
    spacesChanged: doors.reload,
    mapPublished,
    publishedMapChanged,
    desksChanged(cohortId: string | null): void {
      if (stopping) return;
      if (cohortId !== null) {
        broadcast(cohortId, { type: 'desksChanged' });
        return;
      }
      const frame = encode({ type: 'desksChanged' });
      for (const connection of connections.everyone()) {
        sendFrame(connection.socket, frame);
      }
    },
    dispose: metrics.dispose,
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      moves.stop();
      presenceSync.stopRenewing();
      walks.cancelAll();
      // Everybody still here, whether or not they moved since the last save:
      // a redeploy should put nobody back at the spawn. Before the sockets
      // close, so the positions written are the ones they stood at.
      stopping = true;
      await positionWrites.stop();
      await presenceSync.leaveAll();
      for (const connection of connections.everyone()) {
        closeFor(connection.socket, 'server shutting down');
      }
    },
  };
}
