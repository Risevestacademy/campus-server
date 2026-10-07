import type { FastifyBaseLogger } from 'fastify';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * How a client is made. Injectable so a test can give the real client a
 * transport that never connects; the options are still decided by the caller.
 */
export type ConnectRedis = (url: string, options: RedisOptions) => Redis;

export const connectRedis: ConnectRedis = (url, options) =>
  new Redis(url, options);

/**
 * For commands somebody is waiting on. A command must fail fast rather than
 * queue while Redis is away: a join should go ahead without it, not wait at a
 * loading screen until Redis comes back — and a write replayed minutes later
 * would land on top of newer ones.
 */
export const FAIL_FAST: RedisOptions = {
  enableOfflineQueue: false,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
};

/**
 * ioredis reports every failed reconnect attempt; one line per outage is what
 * somebody reading the logs needs.
 */
export function logOutages(
  redis: Redis,
  log: FastifyBaseLogger,
  client: string,
  consequence: string,
): void {
  let healthy: boolean | undefined;
  redis.on('ready', () => {
    healthy = true;
    log.info({ client }, 'redis connected');
  });
  redis.on('error', (err: Error) => {
    if (healthy !== false) {
      log.warn({ err, client }, `redis unavailable: ${consequence}`);
    }
    healthy = false;
  });
}
