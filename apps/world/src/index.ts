import type { World } from './app.js';
import { loadEnv } from './infra/env.js';
import { flushAll } from './infra/exit.js';
import { QUIET_ROUTES } from './quiet-routes.js';

const env = loadEnv();

// Telemetry patches modules as they load, so it starts before the app is
// imported.
const telemetry = env.FF_OTEL_ENABLED
  ? (await import('@campus/telemetry')).startTelemetry({
      serviceName: env.OTEL_SERVICE_NAME,
      version: env.RAILWAY_GIT_COMMIT_SHA ?? 'local',
      environment: env.DEPLOYMENT_ENVIRONMENT,
      metrics: env.FF_OTEL_METRICS_ENABLED,
      untracedPaths: QUIET_ROUTES,
    })
  : undefined;

const { buildWorld } = await import('./app.js');
let world: World;
try {
  world = await buildWorld(env);
} catch (err) {
  // No app yet, so no logger and no reporter: telemetry alone is flushed.
  console.error('failed to build world', err);
  await flushAll(console, [telemetry]);
  process.exit(1);
}
const { app, gateway, accounts, positions, presence, reporter } = world;

/** Last, so it sends whatever the steps before it logged. */
const flush = () => flushAll(app.log, [reporter, telemetry]);

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
