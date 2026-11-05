import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { Env } from '../infra/env.js';
import type { WorldMetrics } from '../infra/metrics.js';
import type { Players } from '../movement/players.js';
import type { WorldMap } from '../movement/world-map.js';
import type { Connection, Connections } from './connections.js';
import { deliver } from './outbound.js';
import {
  CLOSES,
  encode,
  type CloseReason,
  type ServerMessage,
} from './protocol.js';

/** What every feature of the gateway may reach: the process, the map, and the sockets. */
export interface WorldContext {
  app: FastifyInstance;
  env: Env;
  map: WorldMap;
  connections: Connections;
  players: Players;
  metrics: WorldMetrics;
  /** Set once shutdown has written everybody, so the closes it causes do not write again. */
  isStopping(): boolean;
  send(ws: WebSocket, message: ServerMessage): void;
  sendFrame(ws: WebSocket, frame: string): void;
  /**
   * For what happens rarely enough to send at once, unlike moves. Only
   * to the cohort it happened in: each cohort is its own campus, and nobody
   * in one sees or hears of anybody in another, though they share this
   * process and the one map it loaded.
   */
  broadcast(
    cohortId: string,
    message: ServerMessage,
    except?: Connection,
  ): void;
  closeFor(socket: WebSocket, reason: CloseReason): void;
}

/**
 * Closes a socket for one of the reasons in CLOSES, with the code that goes
 * with it. A reason is all a caller names, so the code it is sent with and
 * what the schema tells clients about it can never disagree.
 */
export function sendClose(socket: WebSocket, reason: CloseReason): void {
  socket.close(CLOSES[reason].code, reason);
}

export function createContext(
  base: Pick<
    WorldContext,
    'app' | 'env' | 'map' | 'connections' | 'players' | 'metrics' | 'isStopping'
  >,
): WorldContext {
  const { app, env, connections, metrics } = base;

  function sendFrame(ws: WebSocket, frame: string): void {
    const bufferedBytes = ws.bufferedAmount;
    const delivery = deliver(ws, frame, env.WORLD_MAX_BUFFERED_BYTES);
    if (delivery === 'sent') {
      metrics.sentFrame();
    } else if (delivery === 'lagging') {
      metrics.closedByServer('not_reading');
      app.log.warn({ bufferedBytes }, 'socket not reading, terminating');
    }
  }

  function send(ws: WebSocket, message: ServerMessage): void {
    sendFrame(ws, encode(message));
  }

  function broadcast(
    cohortId: string,
    message: ServerMessage,
    except?: Connection,
  ): void {
    const frame = encode(message);
    for (const connection of connections.all()) {
      if (connection.cohortId === cohortId && connection !== except) {
        sendFrame(connection.socket, frame);
      }
    }
  }

  function closeFor(socket: WebSocket, reason: CloseReason): void {
    metrics.closedByServer(reason);
    sendClose(socket, reason);
  }

  return { ...base, send, sendFrame, broadcast, closeFor };
}
