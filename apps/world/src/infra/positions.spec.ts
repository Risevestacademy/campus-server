import { describe, expect, it } from 'vitest';

import {
  PLACEHOLDER_MAP_ID,
  RedisPositionStore,
  positionKey,
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

describe('RedisPositionStore', () => {
  it('gives back what it saved', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await store.save([{ userId: 'ada', x: 3, y: 4, facing: 'left' }]);

    await expect(store.load('ada')).resolves.toEqual({ x: 3, y: 4, facing: 'left' });
  });

  it('keeps each position for the TTL, refreshed on every save', async () => {
    const { redis, ttls } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await store.save([{ userId: 'ada', x: 0, y: 0, facing: 'down' }]);

    expect(ttls.get(positionKey('ada'))).toBe(90 * 86_400);
  });

  it('has nothing for somebody never saved', async () => {
    const store = new RedisPositionStore(fakeRedis().redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('nobody')).resolves.toBeUndefined();
  });

  /** Once real maps load, a placeholder position belongs to a map that is gone. */
  it('ignores a position saved on another map', async () => {
    const { redis } = fakeRedis();
    await new RedisPositionStore(redis, 'old-map', 90).save([
      { userId: 'ada', x: 3, y: 4, facing: 'left' },
    ]);

    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('ada')).resolves.toBeUndefined();
  });

  it.each([
    ['not JSON', '{nope'],
    ['the wrong shape', JSON.stringify({ mapId: PLACEHOLDER_MAP_ID, x: 'far' })],
    ['an unknown facing', JSON.stringify({ mapId: PLACEHOLDER_MAP_ID, x: 1, y: 1, facing: 'north' })],
  ])('treats %s as nothing saved', async (_label, raw) => {
    const { redis, values } = fakeRedis();
    values.set(positionKey('ada'), raw);
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);

    await expect(store.load('ada')).resolves.toBeUndefined();
  });

  it('forgets', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);
    await store.save([{ userId: 'ada', x: 1, y: 1, facing: 'up' }]);

    await store.forget('ada');

    await expect(store.load('ada')).resolves.toBeUndefined();
  });

  /** The gateway retries a failed save, so a failure has to reach it. */
  it('reports a save Redis refused', async () => {
    const { redis, failNextExec } = fakeRedis();
    const store = new RedisPositionStore(redis, PLACEHOLDER_MAP_ID, 90);
    failNextExec();

    await expect(
      store.save([{ userId: 'ada', x: 1, y: 1, facing: 'up' }]),
    ).rejects.toThrow('READONLY');
  });

  describe('ready', () => {
    /** A Redis client that becomes ready when told to. */
    function connecting() {
      const listeners = new Set<() => void>();
      const redis = {
        ...fakeRedis().redis,
        status: 'connecting',
        once: (_event: 'ready', listener: () => void) => listeners.add(listener),
        off: (_event: 'ready', listener: () => void) => listeners.delete(listener),
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
      const store = new RedisPositionStore(fakeRedis().redis, PLACEHOLDER_MAP_ID, 90);

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
