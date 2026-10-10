import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { createAccountLookup, type AccountLookup } from './infra/accounts.js';
import { loadEnv, type Env } from './infra/env.js';
import { createPositionStore, type PositionStore } from './infra/positions.js';
import { createPresenceStore, type PresenceStore } from './infra/presence.js';
import { loadWorldMap } from './infra/world-map.js';
import { registerConnectionCheck } from './media/connection-check.js';
import {
  CORRELATION_ID_HEADER,
  correlationId,
  loggerOptions,
} from './infra/logger.js';
import type { WorldMap } from './movement/world-map.js';
import { registerGateway, type Gateway } from './socket/gateway.js';
import { protocolAsyncApi } from './socket/protocol.asyncapi.js';
import { protocolDocsPage } from './socket/protocol.docs.js';
import { protocolJsonSchema } from './socket/protocol.schema.js';

export interface World {
  app: FastifyInstance;
  gateway: Gateway;
  env: Env;
  accounts: AccountLookup;
  positions: PositionStore;
  presence: PresenceStore;
}

export async function buildWorld(
  env: Env = loadEnv(),
  // Injectable so tests can answer for the database without one.
  accounts: AccountLookup = createAccountLookup(env),
  // Also injectable; defaults to Redis when REDIS_URL is set, nothing if not.
  positions?: PositionStore,
  // Redis when REDIS_URL is set, memory if not.
  presence?: PresenceStore,
  // The published entry map when left out, which is a call to Sanity.
  map?: WorldMap,
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

  // Before any socket is accepted, and before anything is connected to: every
  // position placed, moved or read back from here on is checked against this
  // map, and a boot that fails for want of one leaves nothing open behind it.
  const worldMap = map ?? (await loadWorldMap(env, app.log));
  const store = positions ?? createPositionStore(env, app.log, worldMap.id);
  const present = presence ?? createPresenceStore(env, app.log);
  const gateway = registerGateway(app, env, accounts, store, present, worldMap);
  registerConnectionCheck(app, env, accounts);

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: { seconds: process.uptime() },
    sockets: {
      connections: gateway.connections.size,
      users: gateway.connections.users,
    },
  }));

  const protocolSchema = `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;
  app.get('/schema.json', async (_request, reply) => {
    void reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300');
    return protocolSchema;
  });

  // The same protocol as an AsyncAPI document, for what reads that: it adds
  // where the socket is, how to get in, and which way each message goes.
  // Named as campus-api names its own: /docs-json for the document, /docs
  // for the page that shows it.
  // Built per request only for the address, which is the caller's own view
  // of this instance — behind a proxy that is the forwarded scheme, since
  // the hop that reaches us is plain.
  app.get('/docs-json', async (request, reply) => {
    const forwarded = request.headers['x-forwarded-proto'];
    const scheme =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        ?.split(',')[0]
        ?.trim() ?? request.protocol;
    void reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300');
    return `${JSON.stringify(
      protocolAsyncApi({ host: request.host, secure: scheme === 'https' }),
      null,
      2,
    )}\n`;
  });

  const docsPage = protocolDocsPage('/docs-json');
  app.get('/docs', async (_request, reply) => {
    void reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=300');
    return docsPage;
  });

  return { app, gateway, env, accounts, positions: store, presence: present };
}
