import { randomUUID } from 'node:crypto';
import { AbstractConnector, Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';
import {
  MemoryPresenceStore,
  RedisPresenceStore,
  DISPLACED_CHANNEL,
  cohortPresenceKey,
  createPresenceStore,
  presenceKey,
  type Displacement,
  type Presence,
  type PresenceStore,
} from './presence.js';

const presenceOf = (
  userId: string,
  overrides: Partial<Presence> = {},
): Presence => ({
  userId,
  connectionId: randomUUID(),
  cohortId: 'cohort-1',
  since: Date.now(),
  ...overrides,
});

describe('MemoryPresenceStore', () => {
  it('lists who is online in a cohort, and nobody from another', async () => {
    const store = new MemoryPresenceStore();
    const ada = presenceOf('ada');
    await store.enter(ada);
    await store.enter(presenceOf('grace', { cohortId: 'cohort-2' }));

    await expect(store.online('cohort-1')).resolves.toEqual([
      { ...ada, instanceId: store.instanceId },
    ]);
  });

  it('leaves only for the connection holding the place', async () => {
    const store = new MemoryPresenceStore();
    const older = presenceOf('ada');
    const newer = presenceOf('ada');
    await store.enter(older);
    await store.enter(newer);

    await store.leave([older]);

    await expect(store.online('cohort-1')).resolves.toHaveLength(1);
  });

  it('reports a renewal for a connection a newer one replaced', async () => {
    const store = new MemoryPresenceStore();
    const older = presenceOf('ada', { since: 1 });
    await store.enter(presenceOf('ada', { since: 2 }));

    await expect(store.renew([older])).resolves.toEqual([
      { userId: 'ada', connectionId: older.connectionId },
    ]);
  });
});

/**
 * Against a real Redis, since the work is in Lua. Set WORLD_TEST_REDIS_URL to
 * run these, ideally naming a database nothing else uses
 * (redis://localhost:6379/15); CI does. Every test uses fresh accounts and
 * cohorts, so they never see each other's entries.
 */
const url = process.env.WORLD_TEST_REDIS_URL;

describe.skipIf(!url)('RedisPresenceStore', () => {
  const clients: Redis[] = [];
  const stores: RedisPresenceStore[] = [];

  /** One world instance: its own clients, as in production. */
  function instance(ttlSeconds = 60) {
    const redis = new Redis(url as string);
    const subscriber = new Redis(url as string);
    clients.push(redis);
    const store = new RedisPresenceStore(redis, subscriber, ttlSeconds);
    stores.push(store);
    const heard: Displacement[] = [];
    store.onDisplaced((displaced) => heard.push(displaced));
    return { store, heard, redis };
  }

  /** Subscribing is asynchronous; a message published before it is lost. */
  const allSubscribed = () =>
    expect
      .poll(async () => {
        const reply = (await clients[0]?.pubsub(
          'NUMSUB',
          DISPLACED_CHANNEL,
        )) as [string, number] | undefined;
        return reply?.[1] ?? 0;
      })
      .toBeGreaterThanOrEqual(stores.length);

  const fresh = () => ({ user: randomUUID(), cohort: randomUUID() });

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.close()));
  });

  it('records the connection, instance and cohort, and lists them', async () => {
    const { user, cohort } = fresh();
    const { store } = instance();
    const ada = presenceOf(user, { cohortId: cohort, spaceId: 'library' });

    await store.enter(ada);

    await expect(store.online(cohort)).resolves.toEqual([
      { ...ada, instanceId: store.instanceId },
    ]);
  });

  it('expires an entry nobody renews', async () => {
    const { user, cohort } = fresh();
    const { store, redis } = instance(0.2);
    await store.enter(presenceOf(user, { cohortId: cohort }));

    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(store.online(cohort)).resolves.toEqual([]);
    await expect(redis.exists(presenceKey(user))).resolves.toBe(0);
  });

  it('keeps a renewed entry past when it would have expired', async () => {
    const { user, cohort } = fresh();
    const { store } = instance(0.3);
    const ada = presenceOf(user, { cohortId: cohort });
    await store.enter(ada);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await store.renew([ada]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(store.online(cohort)).resolves.toHaveLength(1);
  });

  it('puts back an entry that lapsed while its connection stayed', async () => {
    const { user, cohort } = fresh();
    const { store, redis } = instance();
    const ada = presenceOf(user, { cohortId: cohort });
    await store.enter(ada);
    await redis.del(presenceKey(user));

    await expect(store.renew([ada])).resolves.toEqual([]);

    await expect(store.online(cohort)).resolves.toHaveLength(1);
  });

  it('tells the instance holding the old connection when another takes over', async () => {
    const { user, cohort } = fresh();
    const a = instance();
    const b = instance();
    await allSubscribed();
    const older = presenceOf(user, { cohortId: cohort });
    await a.store.enter(older);

    await b.store.enter(presenceOf(user, { cohortId: cohort }));

    await expect
      .poll(() => a.heard)
      .toContainEqual({ userId: user, connectionId: older.connectionId });
    const [entry] = await a.store.online(cohort);
    expect(entry?.instanceId).toBe(b.store.instanceId);
  });

  it('tells nobody when the old connection was on the same instance', async () => {
    const { user, cohort } = fresh();
    const a = instance();
    await allSubscribed();
    await a.store.enter(presenceOf(user, { cohortId: cohort }));

    await a.store.enter(presenceOf(user, { cohortId: cohort }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.heard).toEqual([]);
  });

  it('leaves only for the connection holding the place', async () => {
    const { user, cohort } = fresh();
    const { store } = instance();
    const older = presenceOf(user, { cohortId: cohort });
    const newer = presenceOf(user, { cohortId: cohort });
    await store.enter(older);
    await store.enter(newer);

    await store.leave([older]);
    await expect(store.online(cohort)).resolves.toHaveLength(1);

    await store.leave([newer]);
    await expect(store.online(cohort)).resolves.toEqual([]);
  });

  it('does not let an older connection renew over a newer one', async () => {
    const { user, cohort } = fresh();
    const a = instance();
    const b = instance();
    const older = presenceOf(user, { cohortId: cohort, since: 1 });
    const newer = presenceOf(user, { cohortId: cohort, since: 2 });
    await a.store.enter(older);
    await b.store.enter(newer);

    await expect(a.store.renew([older])).resolves.toEqual([
      { userId: user, connectionId: older.connectionId },
    ]);
    const [entry] = await a.store.online(cohort);
    expect(entry?.connectionId).toBe(newer.connectionId);
  });

  /** When the newer one could not enter, Redis being away at the time. */
  it('lets a newer connection renew over an older one, and tells its instance', async () => {
    const { user, cohort } = fresh();
    const a = instance();
    const b = instance();
    await allSubscribed();
    const older = presenceOf(user, { cohortId: cohort, since: 1 });
    await a.store.enter(older);

    await b.store.renew([presenceOf(user, { cohortId: cohort, since: 2 })]);

    await expect
      .poll(() => a.heard)
      .toContainEqual({ userId: user, connectionId: older.connectionId });
  });

  it('lists somebody only in the cohort they are in now', async () => {
    const { user, cohort } = fresh();
    const elsewhere = randomUUID();
    const { store, redis } = instance();
    await store.enter(presenceOf(user, { cohortId: cohort }));

    await store.enter(presenceOf(user, { cohortId: elsewhere }));

    await expect(store.online(cohort)).resolves.toEqual([]);
    await expect(store.online(elsewhere)).resolves.toHaveLength(1);
    // Left behind in the old index until it lapses; only the entry counts.
    await expect(
      redis.zscore(cohortPresenceKey(cohort), user),
    ).resolves.not.toBeNull();
  });
});

describe('createPresenceStore', () => {
  const log = { info: () => undefined, warn: () => undefined } as never;

  it('keeps presence in memory when REDIS_URL is unset', () => {
    const env = loadEnv({
      AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
      DEPLOYMENT_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://unused',
    } as NodeJS.ProcessEnv);

    expect(createPresenceStore(env, log)).toBeInstanceOf(MemoryPresenceStore);
  });

  /** As for positions: nothing may queue up behind a Redis that is not there. */
  describe('with Redis unavailable', () => {
    class Unreachable extends AbstractConnector {
      constructor() {
        super(0);
      }
      connect(): Promise<never> {
        return new Promise(() => undefined);
      }
    }

    const env = loadEnv({
      AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
      DEPLOYMENT_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://unused',
      REDIS_URL: 'redis://unreachable.invalid:6379',
    } as NodeJS.ProcessEnv);

    const afterOneTurn = (operation: Promise<unknown>) =>
      Promise.race([
        operation.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise((resolve) => setImmediate(() => resolve('pending'))),
      ]);

    let store: PresenceStore;
    afterEach(async () => {
      await store.close();
    });

    it.each([
      ['enter', (s: PresenceStore) => s.enter(presenceOf('ada'))],
      ['renew', (s: PresenceStore) => s.renew([presenceOf('ada')])],
      ['leave', (s: PresenceStore) => s.leave([presenceOf('ada')])],
      ['online', (s: PresenceStore) => s.online('cohort-1')],
    ])('refuses %s at once instead of queueing it', async (_name, operate) => {
      store = createPresenceStore(
        env,
        log,
        (target, options) =>
          new Redis(target, { ...options, Connector: Unreachable }),
      );

      await expect(afterOneTurn(operate(store))).resolves.toBe('rejected');
    });
  });
});
