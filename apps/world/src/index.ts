import { matchesPath } from '@campus/telemetry/paths';

import { loadEnv } from './infra/env.js';

const env = loadEnv();

const UNTRACED_PATHS = ['/health'];

// Telemetry patches modules as they load, so it starts before the app is
// imported.
const telemetry = env.FF_OTEL_ENABLED
  ? (await import('@campus/telemetry')).startTelemetry({
      serviceName: env.OTEL_SERVICE_NAME,
      version: env.RAILWAY_GIT_COMMIT_SHA ?? 'local',
      environment: env.DEPLOYMENT_ENVIRONMENT,
      metrics: env.FF_OTEL_METRICS_ENABLED,
      untracedPaths: UNTRACED_PATHS,
      // Imported, not required, so it goes through the ESM hook.
      esmModules: ['ioredis'],
      instrumentations: [
        new (await import('@fastify/otel')).FastifyOtelInstrumentation({
          registerOnInitialization: true,
          ignorePaths: ({ url }) => matchesPath(url, UNTRACED_PATHS),
        }),
        // Only inside a span: the timers' own reads and writes, every few
        // seconds for every socket, would bury everything else.
        new (
          await import('@opentelemetry/instrumentation-ioredis')
        ).IORedisInstrumentation({ requireParentSpan: true }),
      ],
    })
  : undefined;

const { buildWorld } = await import('./app.js');
const { app, gateway, accounts, positions, presence, reporter } =
  await buildWorld(env);

/** Last, so it sends whatever the steps before it logged. Never throws. */
async function flush(): Promise<void> {
  const results = await Promise.allSettled([
    reporter.shutdown(),
    telemetry?.shutdown(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      app.log.warn({ err: result.reason }, 'could not flush on exit');
    }
  }
}

/**
 * Sockets first, then the HTTP server: a client that is told to go away can
 * reconnect elsewhere, while one still holding an open socket during the
 * close would simply be cut off.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  let failed = false;
  try {
    // stop() writes everybody's position and presence, so Redis closes after it.
    await gateway.stop();
    await app.close();
    await accounts.close();
    await positions.close();
    await presence.close();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    failed = true;
  }
  await flush();
  process.exit(failed ? 1 : 0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// Before any socket: after a redeploy everybody reconnects at once, and a
// Redis still connecting would put them all at the spawn. Bounded, so Redis
// being down delays the start by moments rather than keeping world down.
if (!(await positions.ready(2_000))) {
  app.log.warn('redis not ready at start: early arrivals start at the spawn');
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  await flush();
  process.exit(1);
}
