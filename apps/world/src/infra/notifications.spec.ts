import {
  NOTIFICATION_CREATED_CHANNEL,
  type NotificationCreated,
} from '@campus/session';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MemoryNotificationFeed,
  RedisNotificationFeed,
} from './notifications.js';

const created = (
  overrides: Partial<NotificationCreated> = {},
): NotificationCreated => ({
  recipientId: randomUUID(),
  cohortId: null,
  id: randomUUID(),
  kind: 'notice_posted',
  referenceType: 'notice',
  referenceId: randomUUID(),
  context: null,
  createdAt: '2026-11-05T09:30:00.000Z',
  ...overrides,
});

describe('MemoryNotificationFeed', () => {
  it("hands world's own straight to whoever listens", async () => {
    const feed = new MemoryNotificationFeed();
    const heard: NotificationCreated[] = [];
    feed.onNotification((message) => heard.push(message));
    const message = created();

    await feed.publish(message);

    expect(heard).toEqual([message]);
  });
});

/**
 * Against a real Redis, as presence's are: set WORLD_TEST_REDIS_URL to run
 * them. Every message names a fresh recipient, so tests never hear each
 * other's.
 */
const url = process.env.WORLD_TEST_REDIS_URL;

describe.skipIf(!url)('RedisNotificationFeed', () => {
  const clients: Redis[] = [];
  const feeds: RedisNotificationFeed[] = [];

  /** One world instance, with its own clients. */
  function instance() {
    const redis = new Redis(url as string);
    const subscriber = new Redis(url as string);
    clients.push(redis);
    const errors: unknown[] = [];
    const feed = new RedisNotificationFeed(redis, subscriber, {
      onError: (err) => errors.push(err),
    });
    feeds.push(feed);
    const heard: NotificationCreated[] = [];
    feed.onNotification((message) => heard.push(message));
    return { feed, heard, errors };
  }

  const allSubscribed = () =>
    expect
      .poll(async () => {
        const reply = (await clients[0]?.pubsub(
          'NUMSUB',
          NOTIFICATION_CREATED_CHANNEL,
        )) as [string, number] | undefined;
        return reply?.[1] ?? 0;
      })
      .toBeGreaterThanOrEqual(feeds.length);

  afterAll(async () => {
    await Promise.all(feeds.map((feed) => feed.close()));
  });

  it('reaches every instance, the one that published included', async () => {
    const one = instance();
    const two = instance();
    await allSubscribed();
    const message = created({ cohortId: randomUUID() });

    await one.feed.publish(message);

    await expect.poll(() => one.heard).toContainEqual(message);
    await expect.poll(() => two.heard).toContainEqual(message);
  });

  it('takes what campus-api publishes, and drops what is not a notification', async () => {
    const { heard, errors } = instance();
    await allSubscribed();
    const publisher = new Redis(url as string);
    clients.push(publisher);
    const message = created();

    await publisher.publish(NOTIFICATION_CREATED_CHANNEL, 'not json');
    await publisher.publish(
      NOTIFICATION_CREATED_CHANNEL,
      JSON.stringify({ recipientId: message.recipientId }),
    );
    await publisher.publish(
      NOTIFICATION_CREATED_CHANNEL,
      JSON.stringify(message),
    );

    await expect.poll(() => heard).toContainEqual(message);
    expect(heard.filter((m) => m.recipientId === message.recipientId)).toEqual([
      message,
    ]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    await publisher.quit();
  });
});
