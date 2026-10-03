import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { createAccountLookup, type AccountLookup } from './infra/accounts.js';
import { loadEnv, type Env } from './infra/env.js';
import { createPositionStore, type PositionStore } from './infra/positions.js';
import {
  CORRELATION_ID_HEADER,
  correlationId,
  loggerOptions,
} from './infra/logger.js';
import { registerGateway, type Gateway } from './socket/gateway.js';

export interface World {
  app: FastifyInstance;
  gateway: Gateway;
  env: Env;
  accounts: AccountLookup;
  positions: PositionStore;
}

export async function buildWorld(
  env: Env = loadEnv(),
  // Injectable so tests can answer for the database without one.
  accounts: AccountLookup = createAccountLookup(env),
  // Also injectable; defaults to Redis when REDIS_URL is set, nothing if not.
  positions?: PositionStore,
): Promise<World> {
  const app = Fastify({
    logger: loggerOptions(env),
    genReqId: (req) => correlationId(req.headers as Record<string, unknown>),
    bodyLimit: env.WORLD_MAX_MESSAGE_BYTES,
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header(CORRELATION_ID_HEADER, request.id);
  });

  // Same error contract as campus-api, so a client parses one shape whichever
  // service answered. The message is only ever ours, never a stack.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
    }
    void reply.status(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_ARGUMENT',
        message: status >= 500 ? 'An unexpected error occurred' : err.message,
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });

  await app.register(websocket, {
    options: { maxPayload: env.WORLD_MAX_MESSAGE_BYTES },
  });

  const store = positions ?? createPositionStore(env, app.log);
  const gateway = registerGateway(app, env, accounts, store);

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: { seconds: process.uptime() },
    sockets: {
      connections: gateway.connections.size,
      users: gateway.connections.users,
    },
  }));

  return { app, gateway, env, accounts, positions: store };
}
