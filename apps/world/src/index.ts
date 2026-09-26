import { buildWorld } from './app.js';

const { app, gateway, env } = await buildWorld();

/**
 * Sockets first, then the HTTP server: a client that is told to go away can
 * reconnect elsewhere, while one still holding an open socket during the
 * close would simply be cut off.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await gateway.stop();
    await app.close();
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

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
