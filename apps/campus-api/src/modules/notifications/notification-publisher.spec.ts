import {
  NOTIFICATION_CREATED_CHANNEL,
  type NotificationCreated,
} from '@campus/session';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';

import { RedisNotificationPublisher } from './notification-publisher.js';
import { NotificationPush } from './notification-push.js';

const message = (recipientId: string): NotificationCreated => ({
  recipientId,
  cohortId: null,
  id: `n-${recipientId}`,
  kind: 'notice_posted',
  referenceType: 'notice',
  referenceId: 'notice-1',
  context: null,
  createdAt: '2026-11-05T09:30:00.000Z',
});

/** The pipeline, answering each publish with `replies`, and the connection. */
function fakeRedis(replies: [Error | null, unknown][] = []) {
  const sent: [string, string][] = [];
  const calls: string[] = [];
  const redis = {
    status: 'wait',
    connect: async () => {
      calls.push('connect');
      redis.status = 'ready';
    },
    quit: async () => {
      calls.push('quit');
      redis.status = 'end';
      return 'OK';
    },
    pipeline: () => {
      const batch = {
        publish: (channel: string, payload: string) => {
          sent.push([channel, payload]);
          return batch;
        },
        exec: async () => replies,
      };
      return batch;
    },
  };
  return { redis: redis as unknown as Redis, sent, calls };
}

describe('RedisNotificationPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects only to publish, and lets go once idle so the API can sleep', async () => {
    vi.useFakeTimers();
    const { redis, calls } = fakeRedis();
    const publisher = new RedisNotificationPublisher(redis, 1_000);

    expect(calls).toEqual([]);
    await Promise.all([
      publisher.publish([message('ada')]),
      publisher.publish([message('bob')]),
    ]);
    expect(calls).toEqual(['connect']);

    await vi.advanceTimersByTimeAsync(999);
    await publisher.publish([message('cy')]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual(['connect']);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['connect', 'quit']);

    await publisher.publish([message('dee')]);
    expect(calls).toEqual(['connect', 'quit', 'connect']);
    await publisher.onModuleDestroy();
    expect(calls).toEqual(['connect', 'quit', 'connect', 'quit']);
  });

  it('publishes each one, as JSON, on the channel world listens to', async () => {
    const { redis, sent } = fakeRedis();

    await new RedisNotificationPublisher(redis).publish([
      message('ada'),
      message('bob'),
    ]);

    expect(sent).toEqual([
      [NOTIFICATION_CREATED_CHANNEL, JSON.stringify(message('ada'))],
      [NOTIFICATION_CREATED_CHANNEL, JSON.stringify(message('bob'))],
    ]);
  });

  it('sends nothing for nothing', async () => {
    const { redis, sent } = fakeRedis();

    await new RedisNotificationPublisher(redis).publish([]);

    expect(sent).toEqual([]);
  });

  it('rejects when Redis refused one', async () => {
    const refused = new Error('Connection is closed.');
    const { redis } = fakeRedis([
      [null, 1],
      [refused, null],
    ]);

    await expect(
      new RedisNotificationPublisher(redis).publish([
        message('ada'),
        message('bob'),
      ]),
    ).rejects.toBe(refused);
  });
});

describe('NotificationPush', () => {
  it('logs a failed publish and resolves, so a notice is never undone by it', async () => {
    const warn = vi.fn();
    const logger = { setContext: () => undefined, warn };
    const push = new NotificationPush(
      { publish: () => Promise.reject(new Error('redis is down')) },
      logger as unknown as PinoLogger,
    );

    await expect(push.send([message('ada')])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, referenceId: 'notice-1' }),
      'notifications written but not pushed',
    );
  });
});
