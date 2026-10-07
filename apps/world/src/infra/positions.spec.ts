import { AbstractConnector, Redis } from 'ioredis';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from './env.js';
import {
  PLACEHOLDER_MAP_ID,
  RedisPositionStore,
  createPositionStore,
  positionKey,
  type PositionStore,
  type RedisLike,
} from './positions.js';

/** Just enough of Redis: values, and the TTL each SET asked for. */
function fakeRedis() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  let failExec = false;
  const redis: RedisLike = {
    get: async (key) => values.get(key) ?? null,
    del: async (key) => (values.delete(key) ? 1 : 0),
    multi: () => {
      const queued: [string, string, number][] = [];
      return {
        set: (key, value, _mode, seconds) => queued.push([key, value, seconds]),
        exec: async () => {
          if (failExec) return [[new Error('READONLY'), null]];
          for (const [key, value, seconds] of queued) {
            values.set(key, value);
            ttls.set(key, seconds);
          }
          return queued.map(() => [null, 'OK'] as [Error | null, unknown]);
        },
      };
    },
    status: 'ready',
    once: () => undefined,
    off: () => undefined,
    quit: async () => 'OK',
    disconnect: () => undefined,
  };
  return {
    redis,
    values,
    ttls,
    failNextExec: () => {
      failExec = true;
    },
  };
}

describe('positionKey', () => {
  it('names the key by account and cohort', () => {
    expect(positionKey('ada', 'cohort-1')).toBe('world:position:ada:cohort-1');
  });
});

describe('RedisPositionStore', () => {
  it('gives back what it saved', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await store.save([
      { userId: 'ada', cohortId: 'cohort-1', x: 3, y: 4, facing: 'left' },
    ]);

    await expect(store.load('ada', 'cohort-1')).resolves.toEqual({
      x: 3,
      y: 4,
      facing: 'left',
    });
  });

  /** Two cohorts, two keys: one person standing in both at once. */
  it('keeps a separate position per cohort, without one overwriting the other', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await store.save([
      { userId: 'ada', cohortId: 'frontend', x: 1, y: 1, facing: 'up' },
    ]);
    await store.save([
      { userId: 'ada', cohortId: 'backend', x: 2, y: 2, facing: 'down' },
    ]);

    await expect(store.load('ada', 'frontend')).resolves.toEqual({
      x: 1,
      y: 1,
      facing: 'up',
    });
    await expect(store.load('ada', 'backend')).resolves.toEqual({
      x: 2,
      y: 2,
      facing: 'down',
    });
  });

  it('keeps each position for the TTL, refreshed on every save', async () => {
    const { redis, ttls } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await store.save([
      { userId: 'ada', cohortId: 'cohort-1', x: 0, y: 0, facing: 'down' },
    ]);

    expect(ttls.get(positionKey('ada', 'cohort-1'))).toBe(90 * 86_400);
  });

  it('has nothing for somebody never saved', async () => {
    const store = new RedisPositionStore(
      fakeRedis().redis,
      PLACEHOLDER_MAP_ID,
      90,
    );

    await expect(store.load('nobody', 'cohort-1')).resolves.toBeUndefined();
  });

  /** Once real maps load, a placeholder position belongs to a map that is gone. */
  it('ignores a position saved on another map', async () => {
    const { redis } = fakeRedis();
    await new RedisPositionStore(redis, 'old-map', 90).save([
      { userId: 'ada', cohortId: 'cohort-1', x: 3, y: 4, facing: 'left' },
    ]);

    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('ada', 'cohort-1')).resolves.toBeUndefined();
  });

  /**
   * Positions used to live under world:position:{userId}, with no cohort.
   * That key is never read: a position from before cohorts belongs to a map
   * that is not this one, and a fallback would resurrect it.
   */
  it('ignores a position saved under the old, cohort-less key', async () => {
    const { redis, values } = fakeRedis();
    values.set(
      'world:position:ada',
      JSON.stringify({ mapId: PLACEHOLDER_MAP_ID, x: 3, y: 4, facing: 'left' }),
    );
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('ada', 'cohort-1')).resolves.toBeUndefined();
  });

  it.each([
    ['not JSON', '{nope'],
    [
      'the wrong shape',
      JSON.stringify({ mapId: PLACEHOLDER_MAP_ID, x: 'far' }),
    ],
    [
      'an unknown facing',
      JSON.stringify({
        mapId: PLACEHOLDER_MAP_ID,
        x: 1,
        y: 1,
        facing: 'north',
      }),
    ],
  ])('treats %s as nothing saved', async (_label, raw) => {
    const { redis, values } = fakeRedis();
    values.set(positionKey('ada', 'cohort-1'), raw);
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('ada', 'cohort-1')).resolves.toBeUndefined();
  });

  it('forgets one cohort, leaving the other', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);
    await store.save([
      { userId: 'ada', cohortId: 'frontend', x: 1, y: 1, facing: 'up' },
    ]);
    await store.save([
      { userId: 'ada', cohortId: 'backend', x: 2, y: 2, facing: 'down' },
    ]);

    await store.forget('ada', 'frontend');

    await expect(store.load('ada', 'frontend')).resolves.toBeUndefined();
    await expect(store.load('ada', 'backend')).resolves.toEqual({
      x: 2,
      y: 2,
      facing: 'down',
    });
  });

  /** The gateway retries a failed save, so a failure has to reach it. */
  it('reports a save Redis refused', async () => {
    const { redis, failNextExec } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);
    failNextExec();

    await expect(
      store.save([
        { userId: 'ada', cohortId: 'cohort-1', x: 1, y: 1, facing: 'up' },
      ]),
    ).rejects.toThrow('READONLY');
  });

  describe('ready', () => {
    /** A Redis client that becomes ready when told to. */
    function connecting() {
      const listeners = new Set<() => void>();
      const redis = {
        ...fakeRedis().redis,
        status: 'connecting',
        once: (_event: 'ready', listener: () => void) =>
          listeners.add(listener),
        off: (_event: 'ready', listener: () => void) =>
          listeners.delete(listener),
      };
      return {
        redis,
        listeners,
        connect: () => {
          redis.status = 'ready';
          for (const listener of listeners) listener();
        },
      };
    }

    it('answers at once when already connected', async () => {
      const store = new RedisPositionStore(
        fakeRedis().redis,
        PLACEHOLDER_MAP_ID,
        90,
      );

      await expect(store.ready(10)).resolves.toBe(true);
    });

    it('waits for the connection', async () => {
      const { redis, connect } = connecting();
      const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

      const ready = store.ready(1_000);
      connect();

      await expect(ready).resolves.toBe(true);
    });

    it('gives up after the timeout, and stops listening', async () => {
      const { redis, listeners } = connecting();
      const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

      await expect(store.ready(20)).resolves.toBe(false);
      expect(listeners.size).toBe(0);
    });
  });
});

/**
 * The store as production builds it — createPositionStore, with the real
 * ioredis client — given a transport that never connects, so Redis is
 * unavailable without relying on a port nobody happens to use.
 *
 * A join waits on a load, so an operation against an unavailable Redis has to
 * be refused, not queued until Redis is back. "Refused" is settled within one
 * turn of the event loop; a queued command would still be pending then.
 */
describe('createPositionStore with Redis unavailable', () => {
  /** A connection attempt that never completes: Redis is simply not there. */
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
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://unreachable.invalid:6379',
  } as NodeJS.ProcessEnv);
  const log = { info: () => undefined, warn: () => undefined } as never;

  /** How the promise stands once everything already due to run has run. */
  const afterOneTurn = (operation: Promise<unknown>) =>
    Promise.race([
      operation.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);

  const build = () =>
    createPositionStore(
      env,
      log,
      (url, options) => new Redis(url, { ...options, Connector: Unreachable }),
    );

  it.each([
    ['load', (store: PositionStore) => store.load('ada', 'cohort-1')],
    [
      'save',
      (store: PositionStore) =>
        store.save([
          { userId: 'ada', cohortId: 'cohort-1', x: 1, y: 1, facing: 'up' },
        ]),
    ],
    ['forget', (store: PositionStore) => store.forget('ada', 'cohort-1')],
  ])('refuses a %s at once instead of queueing it', async (_name, operate) => {
    const store = build();

    await expect(afterOneTurn(operate(store))).resolves.toBe('rejected');

    await store.close();
  });

  it('reports not ready, without waiting past the timeout it was given', async () => {
    const store = build();

    await expect(store.ready(1)).resolves.toBe(false);

    await store.close();
  });
});

/**
 * The other way Redis fails: connected, then silent. Nothing is refused at
 * the door, so only the command timeout stands between a join and waiting on
 * a load for as long as Redis stays quiet. Built through createPositionStore
 * with the real client; time is faked, so nothing here waits on the clock.
 */
describe('createPositionStore with Redis connected but not answering', () => {
  /**
   * Connects at once and answers the client's startup commands, as an older
   * Redis would — no HELLO, OK to CLIENT SETINFO, a reply to the INFO
   * readiness check — then says nothing to anything else: a Redis that has
   * stalled. Replies go out in the order the commands came in, which is how
   * the client matches them up.
   */
  class Stalled extends AbstractConnector {
    constructor() {
      super(0);
    }
    connect(): Promise<never> {
      const stream = new Duplex({
        read: () => undefined,
        write(chunk: Buffer, _encoding, done) {
          // Each command is an array whose first bulk string is its name.
          const names = [
            ...chunk.toString().matchAll(/\*\d+\r\n\$\d+\r\n(\w+)/g),
          ];
          for (const [, name] of names) {
            const command = name.toLowerCase();
            if (command === 'hello') {
              stream.push("-ERR unknown command 'hello'\r\n");
            } else if (command === 'client') {
              stream.push('+OK\r\n');
            } else if (command === 'info') {
              const body = 'redis_version:7.0.0';
              stream.push(`$${body.length}\r\n${body}\r\n`);
            }
          }
          done();
        },
      });
      // The two socket calls the client makes on a connected stream.
      Object.assign(stream, {
        setNoDelay: () => stream,
        setKeepAlive: () => stream,
      });
      return Promise.resolve(stream as never);
    }
  }

  const env = loadEnv({
    AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://stalled.invalid:6379',
  } as NodeJS.ProcessEnv);
  const log = { info: () => undefined, warn: () => undefined } as never;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a load once the command timeout passes, not before', async () => {
    const store = createPositionStore(
      env,
      log,
      (url, options) => new Redis(url, { ...options, Connector: Stalled }),
    );
    await expect(store.ready(1_000)).resolves.toBe(true);
    // Only timers are faked; the stream still runs on real ticks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let outcome = 'pending';
    store.load('ada', 'cohort-1').then(
      () => (outcome = 'resolved'),
      () => (outcome = 'rejected'),
    );

    // Sent and unanswered: still waiting, as it would without a timeout.
    await vi.advanceTimersByTimeAsync(499);
    expect(outcome).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('rejected');

    vi.useRealTimers();
    await store.close();
  });
});
