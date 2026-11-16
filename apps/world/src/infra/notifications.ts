import {
  NOTIFICATION_CREATED_CHANNEL,
  type NotificationCreated,
} from '@campus/session';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Env } from './env.js';
import {
  FAIL_FAST,
  connectRedis,
  logOutages,
  type ConnectRedis,
} from './redis.js';

/**
 * New notifications, campus-api's and world's own, for the gateway to push
 * to whichever of the recipient's sockets this instance holds. Every
 * instance hears every one.
 *
 * Best effort, like everything world keeps in Redis: one missed while Redis
 * is away is still in the recipient's list, and they see it there.
 */
export interface NotificationFeed {
  onNotification(listener: (created: NotificationCreated) => void): void;
  /** For world's own, once written. Rejects if it could not be sent. */
  publish(created: NotificationCreated): Promise<void>;
  close(): Promise<void>;
}

const notificationCreated = z.object({
  recipientId: z.string(),
  cohortId: z.string().nullable(),
  id: z.string(),
  kind: z.string(),
  referenceType: z.string(),
  referenceId: z.string(),
  context: z
    .object({ cohortId: z.string(), spaceKey: z.string() })
    .nullable()
    .default(null),
  createdAt: z.string(),
}) satisfies z.ZodType<NotificationCreated>;

export class RedisNotificationFeed implements NotificationFeed {
  private readonly listeners: ((created: NotificationCreated) => void)[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly subscriber: Redis,
    { onError = () => undefined }: { onError?: (err: unknown) => void } = {},
  ) {
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== NOTIFICATION_CREATED_CHANNEL) return;
      try {
        const parsed = notificationCreated.safeParse(JSON.parse(raw));
        if (!parsed.success) throw parsed.error;
        for (const listener of this.listeners) listener(parsed.data);
      } catch (err) {
        onError(err);
      }
    });
    subscriber.subscribe(NOTIFICATION_CREATED_CHANNEL).catch(onError);
  }

  onNotification(listener: (created: NotificationCreated) => void): void {
    this.listeners.push(listener);
  }

  /** Comes back here too, as to every instance: the gateway pushes it then. */
  async publish(created: NotificationCreated): Promise<void> {
    await this.redis.publish(
      NOTIFICATION_CREATED_CHANNEL,
      JSON.stringify(created),
    );
  }

  async close(): Promise<void> {
    this.subscriber.disconnect();
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

/**
 * For one instance on its own, when REDIS_URL is unset: world's own are
 * handed straight to the gateway. campus-api's never arrive.
 */
export class MemoryNotificationFeed implements NotificationFeed {
  private readonly listeners: ((created: NotificationCreated) => void)[] = [];

  onNotification(listener: (created: NotificationCreated) => void): void {
    this.listeners.push(listener);
  }

  async publish(created: NotificationCreated): Promise<void> {
    for (const listener of this.listeners) listener(created);
  }

  async close(): Promise<void> {}
}

export function createNotificationFeed(
  env: Env,
  log: FastifyBaseLogger,
  connect: ConnectRedis = connectRedis,
): NotificationFeed {
  if (!env.REDIS_URL) {
    log.warn(
      "REDIS_URL is unset: campus-api's notifications are not pushed, only listed",
    );
    return new MemoryNotificationFeed();
  }

  const redis = connect(env.REDIS_URL, FAIL_FAST);
  logOutages(
    redis,
    log,
    'notifications',
    'notifications are not pushed until it is back',
  );
  // As presence's: subscribed for the life of the process, so it waits out
  // an outage and resubscribes, its outages reported by the client above.
  const subscriber = connect(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', () => undefined);

  return new RedisNotificationFeed(redis, subscriber, {
    onError: (err) => {
      log.warn({ err }, 'could not handle a notification message');
    },
  });
}
