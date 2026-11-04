import { DEFAULT_SPACE_KEY } from '@campus/session';
import { mayEnter, type CohortMembershipFacts } from '@campus/space-access';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import { type AccountLookup } from '../infra/accounts.js';
import { mediaCredentials, type Env } from '../infra/env.js';
import { worldMetrics } from '../infra/metrics.js';
import { annotate, traced } from '../infra/traced.js';
import type { PositionStore, SavedPosition } from '../infra/positions.js';
import type { PresenceStore } from '../infra/presence.js';
import { type Tile } from '../movement/grid.js';
import { Players } from '../movement/players.js';
import { spaceAt } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import { seatKey, type Seat } from '../seat.js';
import { Availability, Status } from '../status/availability.js';
import {
  decideUpgrade,
  type Refusal,
  type UpgradeDecision,
} from './authenticate.js';
import { Connections, personOf, type Connection } from './connections.js';
import { createContext, sendClose } from './context.js';
import { SayBudget } from './earshot.js';
import { COHORT_QUERY_PARAM, SOCKET_PATH } from './endpoint.js';
import { FrameBudget } from './frame-budget.js';
import { avatarOf, createAppearance } from './features/appearance.js';
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
import { ServerErrorCode, decode, encode } from './protocol.js';

/** How one upgrade ended, counted once, whichever way it ends. */
interface Attempt {
  outcome?: 'opened' | 'refused' | 'failed' | 'abandoned';
}

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
   * campus-api says who holds a desk may have changed, in one cohort or, with
   * null, in every cohort: tell the people there to fetch the desks again.
   */
  desksChanged(cohortId: string | null): void;
  stop(): Promise<void>;
  /**
   * Stops the gauges reading the sockets. Not part of stop(), so the final
   * flush after it still reads the last counts.
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
    walks.cancel(connection);
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
    if (players.leave(connection, Date.now(), remember)) {
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
    for (const connection of connections.all()) {
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
      presenceSync.checkIdle(connection, now);
      connection.alive = false;
      connection.socket.ping();
    }
  }, env.WORLD_HEARTBEAT_SECONDS * 1000);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  // The handler returns its promise so @fastify/websocket can catch a
  // rejection; returning undefined would turn one bad socket into an
  // unhandled rejection that takes the whole process down.
  // Fastify's own span for an upgrade never ends: the socket takes the reply
  // over. world.socket.open is the trace instead.
  app.get(
    SOCKET_PATH,
    { websocket: true, config: { otel: false } },
    async (socket, request) => {
      const attempt: Attempt = {};
      await traced(
        'world.socket.open',
        async () => {
          try {
            await openConnection(
              socket,
              {
                origin: request.headers.origin,
                cookie: request.headers.cookie,
                authorization: request.headers.authorization,
              },
              cohortIdFrom(request.query),
              attempt,
            );
          } catch (err) {
            // Thrown before any outcome was counted: world's own failure.
            if (attempt.outcome === undefined) {
              attempt.outcome = 'failed';
              metrics.failed();
              annotate({ 'world.outcome': 'failed' });
            }
            throw err;
          }
        },
        { root: true },
      );
    },
  );

  async function openConnection(
    ws: WebSocket,
    headers: { origin?: string; cookie?: string; authorization?: string },
    cohortId: string | undefined,
    attempt: Attempt,
  ): Promise<void> {
    // Authentication is asynchronous, and a client can be gone before it
    // finishes. Watching for that now means a socket that dies in the
    // meantime is never registered, rather than registered and never removed.
    // Nothing is read off the socket until there is something to read it
    // with. ws parses frames as they arrive and emits them whether or not a
    // listener exists, so a client that sends the moment it is open would
    // otherwise lose those frames while authentication is still in flight.
    ws.pause();

    let registered: Connection | undefined;
    let closed = false;
    const onClose = (code: number): void => {
      metrics.closed(code);
      closed = true;
      if (registered) {
        drop(registered);
        app.log.info(
          { connectionId: registered.id, userId: registered.userId },
          'socket closed',
        );
      }
    };
    ws.on('close', onClose);
    ws.on('error', (err: Error) => {
      app.log.warn({ err }, 'socket errored');
    });

    let decision;
    try {
      decision = await decideUpgrade(env, accounts, headers, cohortId);
    } catch (err) {
      app.log.error({ err }, 'could not decide socket upgrade');
      attempt.outcome = 'failed';
      metrics.failed();
      annotate({ 'world.outcome': 'failed' });
      // Reading has to resume for the closing handshake to complete.
      ws.resume();
      sendClose(ws, 'internal_error');
      return;
    }
    // Known before the outcome, so a refusal leads to the person too.
    annotate({
      'world.cohort_id': cohortId,
      'user.id': decision.ok ? decision.claims.userId : decision.userId,
    });

    // Access taken away — the account suspended, or gone — forgets the
    // cohort this attempt named, and closes every socket the account holds,
    // in every cohort, the way the sweep closes them: through drop(), which
    // forgets each of those cohorts' kept positions too. Taking the player
    // away underneath an open socket would leave it registered with nobody
    // standing for it, so nobody would be told they left and its next move
    // would throw.
    if (!decision.ok && decision.userId) {
      const { userId } = decision;
      if (cohortId !== undefined) {
        positionWrites.forget({ userId, cohortId });
      }
      const open = connections.forUser(userId);
      for (const connection of open) {
        app.log.info(
          {
            connectionId: connection.id,
            userId,
            cohortId: connection.cohortId,
            reason: decision.refusal,
          },
          'closing socket, account no longer welcome',
        );
        drop(connection, false);
        closeFor(connection.socket, decision.refusal);
      }
      if (
        cohortId !== undefined &&
        !open.some((c) => c.cohortId === cohortId)
      ) {
        players.leave({ userId, cohortId }, Date.now(), false);
      }
    }

    // Where they stood on an earlier visit to this cohort, read before the
    // socket is checked again: the read is asynchronous too, and the socket
    // may go in the meantime. Skipped when this process will resume a
    // position in this same cohort — another tab, or a reconnect within the
    // grace. What the account holds in other cohorts has no bearing on it.
    let saved: SavedPosition | undefined;
    if (
      decision.ok &&
      !players.has(seatOf(decision)) &&
      !players.isRemembered(seatOf(decision))
    ) {
      try {
        saved = await positions.load(seatOf(decision));
      } catch (err) {
        app.log.warn(
          { err, userId: decision.claims.userId },
          'could not load saved position, starting at the spawn',
        );
      }
    }

    // Their membership row, for the doors, and the doors themselves on the
    // first arrival after boot. An admin's row is never read: the door
    // admits them on their role. A row that cannot be read leaves them in
    // the corridors until the heartbeat reads it.
    let membership: CohortMembershipFacts | null = null;
    // Whether the doors know who this is. An admin needs no row; anybody
    // else's has to have been read for a refusal to mean anything.
    let membershipKnown = decision.ok && decision.account.admin;
    if (decision.ok && !decision.account.admin) {
      const seat = seatOf(decision);
      try {
        membership =
          (await accounts.memberships([seat])).get(seatKey(seat)) ?? null;
        membershipKnown = true;
      } catch (err) {
        app.log.warn(
          { err, userId: seat.userId },
          'could not read membership for the doors, reading it again at the heartbeat',
        );
      }
    }
    await doors.ready;

    if (closed || ws.readyState !== ws.OPEN) {
      attempt.outcome = 'abandoned';
      metrics.abandoned();
      annotate({ 'world.outcome': 'abandoned' });
      return;
    }

    if (!decision.ok) {
      attempt.outcome = 'refused';
      refuse(ws, decision.refusal);
      return;
    }

    // A tab replacing another in this cohort keeps the status chosen there,
    // as the avatar keeps its place: nobody saw it leave. Anything else is a
    // fresh arrival, and starts Available. A status is per cohort, as the
    // avatar is: what they show in one campus says nothing in another.
    const replacing = connections.holderOf(seatOf(decision));
    const connection: Connection = {
      id: randomUUID(),
      userId: decision.claims.userId,
      email: decision.claims.email,
      cohortId: decision.cohortId,
      appearance: {
        displayName: decision.account.displayName,
        spriteKey: decision.account.spriteKey,
      },
      // Where the avatar stands is known once it has joined, below.
      spaceKey: DEFAULT_SPACE_KEY,
      systemRole: decision.account.systemRole,
      membership,
      nearby: new Set(),
      availability: new Availability(
        replacing?.availability.chosen ?? Status.Available,
        Date.now(),
      ),
      expiresAt: decision.claims.expiresAt,
      sessionId: decision.claims.sessionId,
      epoch: decision.claims.epoch,
      socket: ws,
      openedAt: Date.now(),
      alive: true,
    };
    registered = connection;

    // Joined before anybody is told, and before any frame is read, so a move
    // can never arrive for a player who is not standing anywhere yet. Another
    // socket for the same account and cohort — loaded while this one waited
    // — has already placed the avatar, and this one takes it over.
    // A saved place inside a space they may no longer enter is not where
    // they come back to: they start at the spawn, as on a first visit. Only
    // when their row and the spaces were both read: a read that failed says
    // nothing about where they may stand, and the place would be lost for
    // good once the spawn was saved over it.
    const savedIn = saved && spaceAt(map.spaces, saved);
    if (
      saved &&
      savedIn &&
      membershipKnown &&
      doors.hasBeenRead() &&
      !mayStepInto(connection, savedIn, new Date())
    ) {
      app.log.info(
        {
          userId: connection.userId,
          cohortId: connection.cohortId,
          spaceKey: savedIn,
          locked: locks.isLocked(connection.cohortId, savedIn),
        },
        'saved position is in a space closed to them now, starting at the spawn',
      );
      saved = undefined;
    }
    const arriving = !players.has(connection);
    const player = players.join(connection, Date.now(), saved);
    connection.spaceKey = spaceAt(map.spaces, player);
    if (arriving) {
      // Told to everyone already in this cohort; the arrival learns of itself
      // from the snapshot.
      broadcast(connection.cohortId, {
        type: 'joined',
        player: avatarOf(player, connection),
      });
    }

    // Registered before the old socket is closed: drop() decides whether the
    // avatar goes by asking whether the account still holds this cohort, so
    // this order is what keeps the replacement from removing it.
    const displaced = connections.add(connection);
    if (displaced) {
      app.log.info(
        {
          connectionId: displaced.id,
          replacedBy: connection.id,
          userId: connection.userId,
          cohortId: connection.cohortId,
        },
        'socket displaced, account entered this cohort elsewhere',
      );
      requests.replaced(displaced);
      send(displaced.socket, { type: 'replaced' });
      closeFor(displaced.socket, 'entered_elsewhere');
      // Only an idle tab replaced by an active one changes what is shown. Not
      // to the new tab, whose welcome has to come first: its snapshot says.
      if (displaced.availability.shown !== connection.availability.shown) {
        broadcast(
          connection.cohortId,
          {
            type: 'statusChanged',
            userId: connection.userId,
            status: connection.availability.shown,
          },
          connection,
        );
      }
    }

    presenceSync.enter(connection);
    app.log.info(
      {
        connectionId: connection.id,
        userId: connection.userId,
        cohortId: connection.cohortId,
      },
      'socket opened',
    );
    attempt.outcome = 'opened';
    metrics.opened();
    annotate({ 'world.outcome': 'opened' });

    ws.on('pong', () => {
      connection.alive = true;
    });

    const budget = new FrameBudget(
      env.WORLD_MAX_MESSAGES_PER_SECOND,
      Date.now(),
    );
    const sayBudget = new SayBudget(Date.now());

    ws.on('message', (raw: Buffer) => {
      // A socket we have dropped can still deliver frames while its close
      // handshake finishes. It no longer speaks for anybody — and its player
      // may be gone, which a move would trip over.
      if (!connections.has(connection)) {
        return;
      }
      // Before parsing, so an excess frame costs only a counter. Closing
      // makes the client reconnect to an authoritative snapshot instead of
      // silently losing a predicted move.
      const admission = budget.admit(Date.now());
      if (admission === 'close') {
        app.log.warn(
          { connectionId: connection.id, userId: connection.userId },
          'socket sending too fast, closing',
        );
        drop(connection);
        closeFor(connection.socket, 'rate_limited');
        return;
      }
      // Frames over WORLD_MAX_MESSAGE_BYTES never arrive: ws enforces
      // maxPayload itself and closes with 1009 before this fires.
      const result = decode(raw.toString('utf8'));
      metrics.received(result.ok ? result.message.type : 'invalid');
      if (!result.ok) {
        send(ws, {
          type: 'error',
          code: ServerErrorCode.BadMessage,
          message: result.reason,
        });
        return;
      }

      switch (result.message.type) {
        case 'ping':
          connection.alive = true;
          send(ws, { type: 'pong' });
          return;
        case 'active':
          presenceSync.noteActivity(connection);
          return;
        case 'setStatus':
          if (
            connection.availability.choose(result.message.status, Date.now())
          ) {
            presenceSync.statusChanged(connection);
          }
          return;
        case 'setLock':
          presenceSync.noteActivity(connection);
          locks.setLock(connection, result.message.locked);
          return;
        case 'requestEntry':
          presenceSync.noteActivity(connection);
          requests.request(connection, result.message.spaceKey);
          return;
        case 'withdrawEntryRequest':
          presenceSync.noteActivity(connection);
          requests.withdraw(connection, result.message.requestId);
          return;
        case 'answerEntryRequest':
          presenceSync.noteActivity(connection);
          requests.answer(
            connection,
            result.message.requestId,
            result.message.admit,
          );
          return;
        case 'say':
          presenceSync.noteActivity(connection);
          chat.say(connection, result.message.text, sayBudget);
          return;
        case 'mute':
          presenceSync.noteActivity(connection);
          void moderation.mute(connection, result.message.userId);
          return;
        case 'removeFromSpace':
          presenceSync.noteActivity(connection);
          moderation.remove(connection, result.message.userId);
          return;
        case 'goTo':
          presenceSync.noteActivity(connection);
          walks.goTo(connection, result.message.userId);
          return;
        case 'goToSpace':
          presenceSync.noteActivity(connection);
          walks.goToSpace(connection, result.message.spaceKey);
          return;
        case 'goToTile':
          presenceSync.noteActivity(connection);
          walks.goToTile(connection, {
            x: result.message.x,
            y: result.message.y,
          });
          return;
        case 'stopWalking':
          presenceSync.noteActivity(connection);
          walks.end(connection, 'stopped');
          return;
        case 'move': {
          presenceSync.noteActivity(connection);
          walks.end(connection, 'stopped');
          const { direction, seq } = result.message;
          const now = Date.now();
          const moved = players.move(
            connection,
            direction,
            now,
            walks.admitsStep(connection, now),
          );
          metrics.moved(moved.outcome);
          send(ws, {
            type: 'moveResult',
            seq,
            outcome: moved.outcome,
            player: moved.player,
          });
          if (moved.outcome === 'moved') arrivedAt(connection, moved.player);
          if (moved.changed) noteMoved(connection);
          return;
        }
      }
    });

    send(ws, {
      type: 'welcome',
      userId: connection.userId,
      connectionId: connection.id,
      heartbeatSeconds: env.WORLD_HEARTBEAT_SECONDS,
      stepMs: env.WORLD_STEP_MS,
      tickMs: env.WORLD_TICK_MS,
      awayAfterSeconds: env.WORLD_AWAY_AFTER_SECONDS,
      ...connection.appearance,
    });
    send(ws, {
      type: 'snapshot',
      map: {
        id: map.id,
        version: map.version,
        width: map.grid.width,
        height: map.grid.height,
      },
      players: appearance.avatarsIn(connection.cohortId),
      lockableSpaces: [...locks.lockableSpaces()],
      lockedSpaces: locks.lockedIn(connection.cohortId),
      spaces: [...doors.names()],
    });
    void calls.join(connection);
    void broadcastRoom.join(connection);
    requests.review(connection.cohortId, connection.spaceKey);

    // Handlers are on: whatever arrived during authentication is delivered
    // now, in the order it was sent.
    ws.resume();
  }

  function refuse(ws: WebSocket, refusal: Refusal): void {
    // The upgrade has already completed by the time Fastify hands the socket
    // over, so a refusal is a close rather than an HTTP status.
    app.log.info({ refusal }, 'socket refused');
    metrics.refused(refusal);
    annotate({ 'world.outcome': 'refused', 'world.refusal': refusal });
    // Paused during authentication; the closing handshake needs it back.
    ws.resume();
    send(ws, {
      type: 'error',
      code: ServerErrorCode.Unauthorized,
      message: refusal,
    });
    sendClose(ws, refusal);
  }

  return {
    connections,
    players,
    appearanceChanged: appearance.changed,
    spacesChanged: doors.reload,
    desksChanged(cohortId: string | null): void {
      if (stopping) return;
      if (cohortId !== null) {
        broadcast(cohortId, { type: 'desksChanged' });
        return;
      }
      const frame = encode({ type: 'desksChanged' });
      for (const connection of connections.all()) {
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
      for (const connection of connections.all()) {
        closeFor(connection.socket, 'server shutting down');
      }
    },
  };
}

/** The seat an accepted upgrade asks for. */
function seatOf(decision: Extract<UpgradeDecision, { ok: true }>): Seat {
  return { userId: decision.claims.userId, cohortId: decision.cohortId };
}

/** A repeated parameter arrives as an array, which reads as none at all. */
function cohortIdFrom(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[COHORT_QUERY_PARAM];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
