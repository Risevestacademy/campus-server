import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { AccountLookup } from '../infra/accounts.js';
import type { Env } from '../infra/env.js';
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
  stop(): Promise<void>;
}

export function registerGateway(
  app: FastifyInstance,
  env: Env,
  accounts: AccountLookup,
): Gateway {
  const connections = new Connections();

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
        connections.remove(connection);
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
        connections.remove(connection);
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
        connections.remove(connection);
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
        connections.remove(registered);
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
    connections.add(connection);
    app.log.info(
      { connectionId: connection.id, userId: connection.userId },
      'socket opened',
    );

    ws.on('pong', () => {
      connection.alive = true;
    });

    ws.on('message', (raw: Buffer) => {
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
        case 'echo':
          send(ws, { type: 'echo', text: result.message.text });
          return;
      }
    });

    send(ws, {
      type: 'welcome',
      userId: connection.userId,
      connectionId: connection.id,
      heartbeatSeconds: env.WORLD_HEARTBEAT_SECONDS,
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
