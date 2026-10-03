import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { AccountLookup } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
import type { PositionStore, SavedPosition } from '../infra/positions.js';
import { Players, type Player } from '../movement/players.js';
import {
  decideUpgrade,
  sessionRefreshedSince,
  type Refusal,
} from './authenticate.js';
import { Connections, type Connection } from './connections.js';
import { FrameBudget } from './frame-budget.js';
import { deliver } from './outbound.js';
import {
  ServerErrorCode,
  decode,
  encode,
  type ServerMessage,
} from './protocol.js';

/** Close codes. 1008 is "policy violation", which is what a refusal is. */
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const GOING_AWAY = 1001;

export interface Gateway {
  connections: Connections;
  players: Players;
  stop(): Promise<void>;
}

export function registerGateway(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
  positions: PositionStore,
): Gateway {
  const connections = new Connections();
  const players = new Players(
    {
      width: env.WORLD_MAP_WIDTH,
      height: env.WORLD_MAP_HEIGHT,
      spawn: { x: env.WORLD_SPAWN_X, y: env.WORLD_SPAWN_Y },
    },
    env.WORLD_STEP_MS,
    env.WORLD_RECONNECT_GRACE_SECONDS * 1000,
  );

  /**
   * Who moved since the last tick, and the socket that made their latest
   * change. Holds names, not positions: the tick reads where each person
   * stands when it runs, so several steps in one tick collapse into the last.
   *
   * Only the latest, not every socket that moved them: that socket's
   * `moveResult` already carries the final position, but an earlier one's
   * does not. With two tabs stepping inside one tick, the first tab's last
   * answer is an intermediate position, and leaving it out of the tick too
   * would strand it there until it happened to move again.
   */
  const pendingMoves = new Map<string, Connection>();

  /**
   * Sends once per tick rather than once per step. Per step, every move is a
   * frame to every socket, so a room of n people walking costs n² frames a
   * step; per tick it is one frame per socket, however many moved.
   */
  function flushMoves(): void {
    if (pendingMoves.size === 0) {
      return;
    }
    const moved: Player[] = [];
    const origins = new Map<Connection, Set<string>>();
    for (const [userId, latestBy] of pendingMoves) {
      const player = players.get(userId);
      // Left since the step: `left` has already gone out, and an entry now
      // would put back an avatar the client has just taken away.
      if (!player) continue;
      moved.push(player);
      const own = origins.get(latestBy);
      if (own) own.add(userId);
      else origins.set(latestBy, new Set([userId]));
    }
    pendingMoves.clear();
    if (moved.length === 0) {
      return;
    }

    // One frame for nearly everybody. Only a socket that made somebody's
    // latest change needs its own, without the entry it already has an
    // answer for.
    const shared = encode({ type: 'moved', players: moved });
    for (const connection of connections.all()) {
      const own = origins.get(connection);
      if (!own) {
        sendFrame(connection.socket, shared);
        continue;
      }
      const others = moved.filter((player) => !own.has(player.userId));
      if (others.length > 0) {
        sendFrame(
          connection.socket,
          encode({ type: 'moved', players: others }),
        );
      }
    }
  }

  const tick = setInterval(flushMoves, env.WORLD_TICK_MS);
  tick.unref();

  /**
   * Who has moved since their position was last written to the store. A
   * name, not a position: the save reads where they stand when it runs.
   */
  const unsaved = new Set<string>();
  /** Set once shutdown has written everybody, so the closes it causes do not write again. */
  let stopping = false;

  /**
   * Writes positions without holding anybody up. A failure only means the
   * position is not kept — see PositionStore — so it is logged, and anybody
   * still here is put back for the next periodic save to retry. Somebody who
   * has left cannot be retried that way: if the save as they left fails,
   * what was last written for them, at most one interval old, stands.
   */
  function persist(standing: Player[]): void {
    if (standing.length === 0) return;
    positions.save(standing).catch((err: unknown) => {
      app.log.warn({ err, count: standing.length }, 'could not save positions');
      for (const player of standing) {
        if (players.has(player.userId)) unsaved.add(player.userId);
      }
    });
  }

  function forgetSaved(userId: string): void {
    unsaved.delete(userId);
    positions.forget(userId).catch((err: unknown) => {
      app.log.warn({ err, userId }, 'could not forget saved position');
    });
  }

  /**
   * Everybody still here who moved since the last write. Somebody who left
   * in the meantime was written as they left (drop), so is skipped here.
   */
  function saveMoved(): void {
    const standing: Player[] = [];
    for (const userId of unsaved) {
      const player = players.get(userId);
      if (player) standing.push(player);
    }
    unsaved.clear();
    persist(standing);
  }

  const periodicSave = setInterval(
    saveMoved,
    env.WORLD_POSITION_SAVE_SECONDS * 1000,
  );
  periodicSave.unref();

  /**
   * Every way a socket stops counting goes through here, so a player can
   * never outlive the last socket standing for them. The avatar stays while
   * any tab is open, and leaves with the last one. Idempotent: a socket
   * dropped by the heartbeat comes back through here from its close event.
   *
   * Where the last tab stood is remembered for the reconnect grace, unless
   * `remember` is false — for access taken away, where a reconnect would be
   * refused anyway and there is nothing to come back to. The avatar leaves
   * everybody else's screen either way: a frozen stand-in for somebody who
   * may never return is worse than a flicker for somebody who does.
   */
  function drop(connection: Connection, remember = true): void {
    connections.remove(connection);
    if (connections.forUser(connection.userId).length > 0) {
      return;
    }
    const standing = players.get(connection.userId);
    if (players.leave(connection.userId, Date.now(), remember)) {
      broadcast({ type: 'left', userId: connection.userId });
    }
    // Kept for the next visit only when they may come back; after shutdown
    // began, everybody has been written already.
    if (!remember) {
      forgetSaved(connection.userId);
    } else if (standing && !stopping) {
      unsaved.delete(connection.userId);
      persist([standing]);
    }
  }

  /**
   * For arrivals and departures, which are rare enough to send at once.
   * Everybody in this process is on the one placeholder map, so everybody
   * hears everything; scoped to a map once maps exist (W6).
   */
  function broadcast(message: ServerMessage): void {
    const frame = encode(message);
    for (const connection of connections.all()) {
      sendFrame(connection.socket, frame);
    }
  }

  /**
   * Checked once per heartbeat rather than per frame: a ban should take
   * effect in seconds, and asking the database on every message would put a
   * query in the path of every movement. One query per distinct user, not
   * per socket, because two tabs are one account.
   */
  async function dropRevokedAccounts(): Promise<void> {
    const byUser = new Map<string, Connection[]>();
    for (const connection of connections.all()) {
      const held = byUser.get(connection.userId);
      if (held) held.push(connection);
      else byUser.set(connection.userId, [connection]);
    }

    for (const [userId, held] of byUser) {
      let account;
      try {
        account = await accounts.find(userId);
      } catch (err) {
        // A database that is not answering must not throw everybody off the
        // campus; the next sweep tries again.
        app.log.error({ err, userId }, 'could not re-check account');
        continue;
      }
      if (account && !account.suspended) {
        dropRevokedSessions(held, account.sessionEpoch);
        continue;
      }

      const reason = account ? 'account_suspended' : 'account_gone';
      for (const connection of held) {
        app.log.info(
          { connectionId: connection.id, userId, reason },
          'closing socket, account no longer welcome',
        );
        drop(connection, false);
        connection.socket.close(POLICY_VIOLATION, reason);
      }
    }
  }

  /**
   * Closes the sockets an account opened before its sessions were revoked.
   * The upgrade refuses a revoked token; this is what reaches the sockets
   * already open, which would otherwise stay until the login stopped being
   * refreshed.
   *
   * Only the ones behind the account's epoch. A tab that signed in again
   * after the bump opened on the new epoch, and is as current as it gets.
   */
  function dropRevokedSessions(held: Connection[], sessionEpoch: number): void {
    for (const connection of held) {
      if (connection.epoch === sessionEpoch) {
        continue;
      }
      app.log.info(
        { connectionId: connection.id, userId: connection.userId },
        'session revoked, closing socket',
      );
      // Remembered, like a sign-out: the account is still welcome, and
      // signing back in may resume where they stood.
      drop(connection);
      connection.socket.close(POLICY_VIOLATION, 'session_revoked');
    }
  }

  /**
   * An access token lasts fifteen minutes and the browser swaps it for a new
   * one through campus-api, which an open socket never sees. So a socket
   * follows the login instead: it stays while that login is live — not
   * signed out, and refreshed recently, which means campus-api has re-checked
   * suspension and access within the window. One query for every socket.
   */
  async function dropEndedSessions(): Promise<void> {
    const following = connections
      .all()
      .filter((c) => c.sessionId !== undefined);
    if (following.length === 0) {
      return;
    }
    const now = new Date();
    let live: Set<string>;
    try {
      live = await accounts.liveSessions(
        following.map((c) => c.sessionId as string),
        sessionRefreshedSince(env, now),
        now,
      );
    } catch (err) {
      // As with accounts: a database that is not answering must not throw
      // everybody off the campus. The next sweep tries again.
      app.log.error({ err }, 'could not re-check sessions');
      return;
    }

    for (const connection of following) {
      if (live.has(connection.sessionId as string)) {
        continue;
      }
      app.log.info(
        { connectionId: connection.id, userId: connection.userId },
        'session ended, closing socket',
      );
      // Remembered: signing out is not access being taken away, and signing
      // straight back in may resume where they stood.
      drop(connection);
      connection.socket.close(POLICY_VIOLATION, 'session_ended');
    }
  }

  /**
   * One of each sweep at a time. The heartbeat does not wait for them, so a
   * database slower than the interval would otherwise stack queries on the
   * pool, and let an older check land after a newer one. A heartbeat that
   * finds its sweep still running skips it; the next one runs with fresh
   * state.
   */
  const sweepFailed = (err: unknown): void => {
    app.log.error({ err }, 'heartbeat sweep failed');
  };
  const sweepAccounts = oneAtATime(dropRevokedAccounts, sweepFailed);
  const sweepSessions = oneAtATime(dropEndedSessions, sweepFailed);

  const heartbeat = setInterval(() => {
    sweepAccounts();
    sweepSessions();
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
        connection.socket.close(POLICY_VIOLATION, 'session_expired');
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
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, env.WORLD_HEARTBEAT_SECONDS * 1000);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  // The handler returns its promise so @fastify/websocket can catch a
  // rejection; returning undefined would turn one bad socket into an
  // unhandled rejection that takes the whole process down.
  app.get('/socket', { websocket: true }, async (socket, request) => {
    await openConnection(socket, {
      origin: request.headers.origin,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
  });

  async function openConnection(
    ws: WebSocket,
    headers: { origin?: string; cookie?: string; authorization?: string },
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
    const onClose = (): void => {
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
      decision = await decideUpgrade(env, accounts, headers);
    } catch (err) {
      app.log.error({ err }, 'could not decide socket upgrade');
      // Reading has to resume for the closing handshake to complete.
      ws.resume();
      ws.close(INTERNAL_ERROR, 'internal_error');
      return;
    }

    // A position kept from an earlier drop must not survive access being
    // taken away. The sweep forgets it only for somebody still connected; a
    // suspended account whose socket had already gone is caught here, at its
    // next attempt — whether or not this socket is still around to be told.
    //
    // Any tab still open for them is closed the way the revocation sweep
    // closes it, through drop(): taking the player away underneath an open
    // tab would leave that tab registered with nobody standing for it, so
    // nobody would be told they left and its next move would throw.
    if (!decision.ok && decision.userId) {
      const open = connections.forUser(decision.userId);
      if (open.length > 0) {
        for (const connection of open) {
          app.log.info(
            {
              connectionId: connection.id,
              userId: connection.userId,
              reason: decision.refusal,
            },
            'closing socket, account no longer welcome',
          );
          drop(connection, false);
          connection.socket.close(POLICY_VIOLATION, decision.refusal);
        }
      } else {
        players.leave(decision.userId, Date.now(), false);
        forgetSaved(decision.userId);
      }
    }

    // Where they stood on an earlier visit, read before the socket is
    // checked again: the read is asynchronous too, and the socket may go in
    // the meantime. Only asked for when this process holds nothing fresher —
    // another tab, or a reconnect within the grace.
    let saved: SavedPosition | undefined;
    if (
      decision.ok &&
      !players.has(decision.claims.userId) &&
      !players.isRemembered(decision.claims.userId)
    ) {
      try {
        saved = await positions.load(decision.claims.userId);
      } catch (err) {
        app.log.warn(
          { err, userId: decision.claims.userId },
          'could not load saved position, starting at the spawn',
        );
      }
    }

    if (closed || ws.readyState !== ws.OPEN) {
      return;
    }

    if (!decision.ok) {
      refuse(ws, decision.refusal);
      return;
    }

    const connection: Connection = {
      id: randomUUID(),
      userId: decision.claims.userId,
      email: decision.claims.email,
      expiresAt: decision.claims.expiresAt,
      sessionId: decision.claims.sessionId,
      epoch: decision.claims.epoch,
      socket: ws,
      alive: true,
    };
    registered = connection;
    // Joined before anybody is told, and before any frame is read, so a move
    // can never arrive for a player who is not standing anywhere yet.
    const arriving = !players.has(connection.userId);
    const player = players.join(connection.userId, Date.now(), saved);
    if (arriving) {
      // Told to everyone already here; the arrival learns of itself from the
      // snapshot. A second tab is not an arrival.
      broadcast({ type: 'joined', player });
    }
    connections.add(connection);
    app.log.info(
      { connectionId: connection.id, userId: connection.userId },
      'socket opened',
    );

    ws.on('pong', () => {
      connection.alive = true;
    });

    const budget = new FrameBudget(
      env.WORLD_MAX_MESSAGES_PER_SECOND,
      Date.now(),
    );

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
        connection.socket.close(POLICY_VIOLATION, 'rate_limited');
        return;
      }
      // Frames over WORLD_MAX_MESSAGE_BYTES never arrive: ws enforces
      // maxPayload itself and closes with 1009 before this fires.
      const result = decode(raw.toString('utf8'));
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
        case 'move': {
          const { direction, seq } = result.message;
          const moved = players.move(connection.userId, direction, Date.now());
          send(ws, {
            type: 'moveResult',
            seq,
            outcome: moved.outcome,
            player: moved.player,
          });
          if (moved.changed) {
            pendingMoves.set(connection.userId, connection);
            unsaved.add(connection.userId);
          }
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
    });
    send(ws, {
      type: 'snapshot',
      map: { width: env.WORLD_MAP_WIDTH, height: env.WORLD_MAP_HEIGHT },
      players: players.all(),
    });

    // Handlers are on: whatever arrived during authentication is delivered
    // now, in the order it was sent.
    ws.resume();
  }

  function refuse(ws: WebSocket, refusal: Refusal): void {
    // The upgrade has already completed by the time Fastify hands the socket
    // over, so a refusal is a close rather than an HTTP status.
    app.log.info({ refusal }, 'socket refused');
    // Paused during authentication; the closing handshake needs it back.
    ws.resume();
    send(ws, {
      type: 'error',
      code: ServerErrorCode.Unauthorized,
      message: refusal,
    });
    ws.close(POLICY_VIOLATION, refusal);
  }

  function send(ws: WebSocket, message: ServerMessage): void {
    sendFrame(ws, encode(message));
  }

  function sendFrame(ws: WebSocket, frame: string): void {
    const bufferedBytes = ws.bufferedAmount;
    if (deliver(ws, frame, env.WORLD_MAX_BUFFERED_BYTES) === 'lagging') {
      app.log.warn({ bufferedBytes }, 'socket not reading, terminating');
    }
  }

  return {
    connections,
    players,
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      clearInterval(tick);
      clearInterval(periodicSave);
      // Everybody still here, whether or not they moved since the last save:
      // a redeploy should put nobody back at the spawn. Before the sockets
      // close, so the positions written are the ones they stood at.
      stopping = true;
      unsaved.clear();
      try {
        await positions.save(players.all());
      } catch (err) {
        app.log.warn({ err }, 'could not save positions on shutdown');
      }
      for (const connection of connections.all()) {
        connection.socket.close(GOING_AWAY, 'server shutting down');
      }
    },
  };
}

/**
 * Wraps an async task so that calling it while a previous call is still
 * running does nothing. A failure goes to `onError` rather than becoming an
 * unhandled rejection, which would take the process down; the guard is
 * released either way, so one bad run does not stop the next.
 */
export function oneAtATime(
  task: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  return () => {
    if (running) {
      return;
    }
    running = true;
    task()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
}
