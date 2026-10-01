import { buildWorld } from './app.js';

const { app, gateway, env, accounts, positions } = await buildWorld();

/**
 * Sockets first, then the HTTP server: a client that is told to go away can
 * reconnect elsewhere, while one still holding an open socket during the
 * close would simply be cut off.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    // stop() writes everybody's position, so Redis closes after it.
    await gateway.stop();
    await app.close();
    await accounts.close();
    await positions.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
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
  process.exit(1);
}
