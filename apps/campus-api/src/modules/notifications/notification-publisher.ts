import {
  NOTIFICATION_CREATED_CHANNEL,
  type NotificationCreated,
} from '@campus/session';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

export const NOTIFICATION_PUBLISHER = Symbol('NOTIFICATION_PUBLISHER');

/** Where a committed notification is announced, for world to push. */
export interface NotificationPublisher {
  /** Rejects when Redis did not take them all. Nothing is retried. */
  publish(messages: readonly NotificationCreated[]): Promise<void>;
}

/** REDIS_URL unset: nothing is pushed, and the list is how they are seen. */
export const disabledNotificationPublisher: NotificationPublisher = {
  publish: async () => undefined,
};

/** As the database pool's idle_timeout, for the same reason: see below. */
export const PUBLISHER_IDLE_MS = 20_000;

/**
 * Connects when there is something to publish and lets go once idle, as
 * the database pool does: a connection held open sends keepalives, which is
 * traffic enough that a serverless deployment never sleeps.
 */
export class RedisNotificationPublisher
  implements NotificationPublisher, OnModuleDestroy
{
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  private idle?: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly idleMs = PUBLISHER_IDLE_MS,
  ) {}

  async publish(messages: readonly NotificationCreated[]): Promise<void> {
    if (messages.length === 0) return;
    clearTimeout(this.idle);
    try {
      await this.connected();
      // One round trip however many recipients a notice has.
      const batch = this.redis.pipeline();
      for (const message of messages) {
        batch.publish(NOTIFICATION_CREATED_CHANNEL, JSON.stringify(message));
      }
      const replies = (await batch.exec()) ?? [];
      const failed = replies.find(([err]) => err);
      if (failed) throw failed[0];
    } finally {
      // Publishes overlap: only the last one's timer may stand.
      clearTimeout(this.idle);
      this.idle = setTimeout(() => void this.close(), this.idleMs);
      this.idle.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearTimeout(this.idle);
    await this.close();
  }

  /**
   * Shared by publishes that arrive while the connection is being made, and
   * after one being let go of, which has to finish before another is made.
   */
  private async connected(): Promise<void> {
    await this.closing;
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private close(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      return Promise.resolve();
    }
    this.closing ??= this.redis
      .quit()
      .then(
        () => undefined,
        () => this.redis.disconnect(),
      )
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}

const logger = new Logger('NotificationPublisher');

/**
 * Fails fast rather than waiting or queueing while Redis is away, as world's
 * clients do: a push is worth something only now. Never reconnects on its
 * own; the next publish connects again.
 */
export function connectNotificationPublisher(
  url: string,
): RedisNotificationPublisher {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // One line per outage, not one per publish that finds it.
  let healthy: boolean | undefined;
  redis.on('ready', () => {
    if (healthy === false) logger.log('redis reachable again');
    healthy = true;
  });
  redis.on('error', (err: Error) => {
    if (healthy !== false) {
      logger.warn(
        `redis unavailable: notifications are not pushed until it is back (${err.message})`,
      );
    }
    healthy = false;
  });
  return new RedisNotificationPublisher(redis);
}
