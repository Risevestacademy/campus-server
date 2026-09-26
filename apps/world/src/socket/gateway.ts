import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

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
const MESSAGE_TOO_BIG = 1009;

export interface Gateway {
  connections: Connections;
  stop(): Promise<void>;
}

export function registerGateway(app: FastifyInstance, env: Env): Gateway {
  const connections = new Connections();

  const heartbeat = setInterval(() => {
    for (const connection of connections.all()) {
      if (!connection.alive) {
        // Missed the last round trip: the socket is open as far as this
        // process knows, and gone as far as anybody else is concerned.
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'socket failed heartbeat, closing',
        );
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, env.WORLD_HEARTBEAT_SECONDS * 1000);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  app.get('/socket', { websocket: true }, (socket, request) => {
    void openConnection(socket, {
      origin: request.headers.origin,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });

    async function openConnection(
      ws: WebSocket,
      headers: { origin?: string; cookie?: string; authorization?: string },
    ): Promise<void> {
      const decision = await decideUpgrade(env, headers);
      if (!decision.ok) {
        refuse(ws, decision.refusal);
        return;
      }

      const connection: Connection = {
        id: randomUUID(),
        userId: decision.claims.userId,
        email: decision.claims.email,
        socket: ws,
        alive: true,
      };
      connections.add(connection);
      app.log.info(
        { connectionId: connection.id, userId: connection.userId },
        'socket opened',
      );

      ws.on('pong', () => {
        connection.alive = true;
      });

      ws.on('message', (raw: Buffer) => {
        if (raw.byteLength > env.WORLD_MAX_MESSAGE_BYTES) {
          send(ws, {
            type: 'error',
            code: ServerErrorCode.TooLarge,
            message: 'message too large',
          });
          ws.close(MESSAGE_TOO_BIG, 'message too large');
          return;
        }

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

      const close = (): void => {
        connections.remove(connection);
        app.log.info(
          { connectionId: connection.id, userId: connection.userId },
          'socket closed',
        );
      };
      ws.on('close', close);
      ws.on('error', (err: Error) => {
        app.log.warn({ err, connectionId: connection.id }, 'socket errored');
      });

      send(ws, {
        type: 'welcome',
        userId: connection.userId,
        connectionId: connection.id,
        heartbeatSeconds: env.WORLD_HEARTBEAT_SECONDS,
      });
    }

    function refuse(ws: WebSocket, refusal: Refusal): void {
      // The upgrade has already completed by the time Fastify hands the
      // socket over, so a refusal is a close rather than an HTTP status.
      app.log.info({ refusal }, 'socket refused');
      send(ws, {
        type: 'error',
        code: ServerErrorCode.Unauthorized,
        message: refusal,
      });
      ws.close(POLICY_VIOLATION, refusal);
    }
  });

  return {
    connections,
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      for (const connection of connections.all()) {
        connection.socket.close(1001, 'server shutting down');
      }
    },
  };
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encode(message));
  }
}
