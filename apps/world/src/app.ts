import {
  createErrorReporter,
  type ErrorReporter,
} from '@campus/error-reporting';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { registerOnlineCount } from './admin/online-count.js';
import { createAccountLookup, type AccountLookup } from './infra/accounts.js';
import { loadEnv, type Env } from './infra/env.js';
import { createPositionStore, type PositionStore } from './infra/positions.js';
import {
  createNotificationFeed,
  type NotificationFeed,
} from './infra/notifications.js';
import { createPresenceStore, type PresenceStore } from './infra/presence.js';
import { loadWorldMap } from './infra/world-map.js';
import { registerConnectionCheck } from './media/connection-check.js';
import {
  CORRELATION_ID_HEADER,
  correlationId,
  loggerOptions,
  silenceRoutes,
} from './infra/logger.js';
import type { WorldMap } from './movement/world-map.js';
import { QUIET_ROUTES } from './quiet-routes.js';
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
  notifications: NotificationFeed;
  reporter: ErrorReporter;
}

/** What a world is built from; every part defaults to the real thing. */
export interface BuildWorldOptions {
  /** The environment to read. Loaded from `process.env` when left out. */
  env?: Env;
  /** Answers for the database. Built from `env` when left out. */
  accounts?: AccountLookup;
  /** Also injectable; defaults to Redis when REDIS_URL is set, nothing if not. */
  positions?: PositionStore;
  /** Redis when REDIS_URL is set, memory if not. */
  presence?: PresenceStore;
  /** Redis when REDIS_URL is set, this instance alone if not. */
  notifications?: NotificationFeed;
  /** The published entry map when left out, which is a call to Sanity. */
  map?: WorldMap;
  /**
   * The same loading path a live reload uses. Left out, it reads the map the
   * database says is published, or the CMS entry map when none is.
   */
  loadMap?: (mapKey?: string) => Promise<WorldMap>;
  /** Where errors are reported. Built from `env` when left out. */
  reporter?: ErrorReporter;
}

export async function buildWorld({
  env = loadEnv(),
  accounts = createAccountLookup(env),
  positions,
  presence,
  notifications,
  map,
  loadMap,
  reporter = createErrorReporter({
    enabled: env.FF_POSTHOG_ENABLED,
    token: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST,
    service: env.OTEL_SERVICE_NAME,
    environment: env.DEPLOYMENT_ENVIRONMENT,
    release: env.RAILWAY_GIT_COMMIT_SHA,
  }),
}: BuildWorldOptions = {}): Promise<World> {
  const app = Fastify({
    logger: loggerOptions(env, reporter),
    genReqId: (req) => correlationId(req.headers as Record<string, unknown>),
    bodyLimit: env.WORLD_MAX_MESSAGE_BYTES,
  });

  silenceRoutes(app, QUIET_ROUTES);

  app.addHook('onSend', async (request, reply) => {
    void reply.header(CORRELATION_ID_HEADER, request.id);
  });

  // Same error contract as campus-api, so a client parses one shape whichever
  // service answered. The message is only ever ours, never a stack.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(
        { err, route: request.routeOptions.url, statusCode: status },
        'unhandled error',
      );
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
  //
  // The database names the entry map an admin has published. With none, world
  // keeps the old behaviour and loads the CMS entry map, so local development
  // works without publishing. The published version itself is not stored;
  // world still reads the current one from Sanity (see the maps README).
  const loader =
    loadMap ??
    ((mapKey?: string) =>
      loadWorldMap(env, app.log, undefined, mapKey, mapKey === undefined));
  let publishedKey: string | null = null;
  if (!map) {
    try {
      publishedKey = await accounts.publishedEntryMapKey();
    } catch (err) {
      // A database that will not answer must not keep the campus shut. The
      // CMS fallback is what world did before publication existed.
      app.log.warn(
        { err },
        'could not read the published map; loading the CMS entry map',
      );
    }
  }
  const worldMap = map ?? (await loader(publishedKey ?? undefined));
  const store = positions ?? createPositionStore(env, app.log, worldMap);
  const present = presence ?? createPresenceStore(env, app.log);
  const feed = notifications ?? createNotificationFeed(env, app.log);
  const gateway = registerGateway(
    app,
    env,
    accounts,
    store,
    present,
    worldMap,
    (mapKey) => loader(mapKey),
    feed,
  );
  feed.onNotification((created) => gateway.notify(created));
  // Not awaited: a database that will not take the listen must not stop the
  // campus opening. The heartbeat re-reads every account, so a change still
  // shows, a heartbeat late.
  accounts
    .onProfileChanged((userId) => void gateway.appearanceChanged(userId))
    .catch((err: unknown) =>
      app.log.error({ err }, 'could not listen for profile changes'),
    );
  // Desks are not kept here: clients fetch them from campus-api when told.
  accounts
    .onDesksChanged((cohortId) => gateway.desksChanged(cohortId))
    .catch((err: unknown) =>
      app.log.error({ err }, 'could not listen for desk changes'),
    );
  // The same for the spaces: the heartbeat reads them again too. A payload
  // is a published map key; an empty one is a space edit. Re-subscribing
  // fires the second callback, which catches a publish sent while this
  // instance was not listening.
  accounts
    .onSpacesChanged(
      (payload) => {
        if (payload) void gateway.mapPublished(payload);
        else void gateway.spacesChanged();
      },
      () => {
        void gateway.spacesChanged();
        void gateway.publishedMapChanged();
      },
    )
    .catch((err: unknown) =>
      app.log.error({ err }, 'could not listen for space changes'),
    );
  registerConnectionCheck(app, env, accounts);
  registerOnlineCount(app, env, accounts, present);

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

  return {
    app,
    gateway,
    env,
    accounts,
    positions: store,
    presence: present,
    notifications: feed,
    reporter,
  };
}
