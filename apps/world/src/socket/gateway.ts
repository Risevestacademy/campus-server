import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { AccountLookup } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
import { Players } from '../movement/players.js';
import { decideUpgrade, type Refusal } from './authenticate.js';
import { Connections, type Connection } from './connections.js';
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
): Gateway {
  const connections = new Connections();
  const players = new Players(
    {
      width: env.WORLD_MAP_WIDTH,
      height: env.WORLD_MAP_HEIGHT,
      spawn: { x: env.WORLD_SPAWN_X, y: env.WORLD_SPAWN_Y },
    },
    env.WORLD_STEP_MS,
  );

  /**
   * Every way a socket stops counting goes through here, so a player can
   * never outlive the last socket standing for them. The avatar stays while
   * any tab is open, and leaves with the last one. Idempotent: a socket
   * dropped by the heartbeat comes back through here from its close event.
   */
  function drop(connection: Connection): void {
    connections.remove(connection);
    if (connections.forUser(connection.userId).length > 0) {
      return;
    }
    if (players.leave(connection.userId)) {
      broadcast({ type: 'left', userId: connection.userId });
    }
  }

  /**
   * Everybody in this process is on the one placeholder map, so everybody
   * hears everything. Scoped to a map once maps exist (W6), and batched per
   * tick rather than sent per step once the tick loop lands (W2).
   */
  function broadcast(message: ServerMessage, except?: Connection): void {
    const frame = encode(message);
    for (const connection of connections.all()) {
      if (connection !== except && connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(frame);
      }
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
        continue;
      }

      const reason = account ? 'account_suspended' : 'account_gone';
      for (const connection of held) {
        app.log.info(
          { connectionId: connection.id, userId, reason },
          'closing socket, account no longer welcome',
        );
        drop(connection);
        connection.socket.close(POLICY_VIOLATION, reason);
      }
    }
  }

  const heartbeat = setInterval(() => {
    void dropRevokedAccounts();
    const now = Date.now();
    for (const connection of connections.all()) {
      // A session that has run out does not get to keep a socket it already
      // holds: otherwise signing out, or simply waiting, leaves the campus
      // open for the rest of the token's twelve hours.
      if (connection.expiresAt.getTime() <= now) {
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
      socket: ws,
      alive: true,
    };
    registered = connection;
    // Joined before anybody is told, and before any frame is read, so a move
    // can never arrive for a player who is not standing anywhere yet.
    const arriving = !players.has(connection.userId);
    const player = players.join(connection.userId, Date.now());
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

    ws.on('message', (raw: Buffer) => {
      // A socket we have dropped can still deliver frames while its close
      // handshake finishes. It no longer speaks for anybody — and its player
      // may be gone, which a move would trip over.
      if (!connections.has(connection)) {
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
          send(ws, { type: 'moveResult', seq, outcome: moved.outcome, player: moved.player });
          if (moved.changed) {
            broadcast({ type: 'moved', player: moved.player }, connection);
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

  return {
    connections,
    players,
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      for (const connection of connections.all()) {
        connection.socket.close(GOING_AWAY, 'server shutting down');
      }
    },
  };
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encode(message));
  }
}
