import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { Direction } from '../movement/grid.js';
import type { Env } from './env.js';
import {
  FAIL_FAST,
  connectRedis,
  logOutages,
  type ConnectRedis,
} from './redis.js';

/**
 * The map everybody stands on until real maps load. Saved with every
 * position, so once maps exist a position from the placeholder is recognised
 * as belonging to a map that is gone, and its owner starts at the spawn.
 */
export const PLACEHOLDER_MAP_ID = 'placeholder';

export interface SavedPosition {
  x: number;
  y: number;
  facing: Direction;
}

/**
 * A position to write and whose it is. The account and cohort travel with the
 * value rather than living on Player, which is sent to clients and must not
 * carry a cohort they have no use for.
 */
export interface PositionToSave extends SavedPosition {
  userId: string;
  cohortId: string;
}

/**
 * Where each player last stood, kept between visits. In Redis rather
 * than Postgres: the data is small, changes often and is cheap to lose — the
 * worst case is one start at the spawn. An interface so the gateway can be
 * tested without Redis, and run without it.
 *
 * Every method may fail, and a caller must treat failure as "nothing kept":
 * a player whose position cannot be read starts at the spawn, and one whose
 * position cannot be written simply loses it. Redis being down must never
 * keep anybody off the campus.
 */
export interface PositionStore {
  /** Undefined when nothing is kept, or what is kept is for another map. */
  load(userId: string, cohortId: string): Promise<SavedPosition | undefined>;
  save(positions: readonly PositionToSave[]): Promise<void>;
  /**
   * For access taken away: there is nothing to come back to. Only the named
   * cohort, because a position is kept per cohort and there is no single
   * entry to remove.
   */
  forget(userId: string, cohortId: string): Promise<void>;
  /**
   * Resolves true once the store can answer, or false after `timeoutMs`.
   * Waited on before accepting sockets: after a redeploy everybody
   * reconnects at once, and a store still connecting would start them all
   * at the spawn.
   */
  ready(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

const stored = z.object({
  mapId: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  facing: z.enum(Direction),
});

export function positionKey(userId: string, cohortId: string): string {
  return `world:position:${userId}:${cohortId}`;
}

/** Keeps nothing: every visit starts at the spawn. For when REDIS_URL is unset. */
export const noPositionStore: PositionStore = {
  load: async () => undefined,
  save: async () => undefined,
  forget: async () => undefined,
  ready: async () => true,
  close: async () => undefined,
};

export function createPositionStore(
  env: Env,
  log: FastifyBaseLogger,
  connect: ConnectRedis = connectRedis,
): PositionStore {
  if (!env.REDIS_URL) {
    log.warn('REDIS_URL is unset: positions are not kept between visits');
    return noPositionStore;
  }

  // A join waits on a load: somebody should start at the spawn, not wait.
  const redis = connect(env.REDIS_URL, FAIL_FAST);
  logOutages(
    redis,
    log,
    'positions',
    'positions will not be kept until it is back',
  );

  return new RedisPositionStore(
    redis,
    PLACEHOLDER_MAP_ID,
    env.WORLD_POSITION_TTL_DAYS,
  );
}

/** The subset of the ioredis client the store uses. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  multi(): {
    set(key: string, value: string, mode: 'EX', seconds: number): unknown;
    exec(): Promise<[Error | null, unknown][] | null>;
  };
  /** ioredis's connection state; 'ready' once commands can run. */
  readonly status: string;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export class RedisPositionStore implements PositionStore {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: RedisLike,
    private readonly mapId: string,
    ttlDays: number,
  ) {
    this.ttlSeconds = ttlDays * 86_400;
  }

  async load(
    userId: string,
    cohortId: string,
  ): Promise<SavedPosition | undefined> {
    const raw = await this.redis.get(positionKey(userId, cohortId));
    if (raw === null) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = stored.safeParse(value);
    // Something written by another version, or for a map that is not this
    // one, is the same as nothing: the spawn is always a safe answer.
    if (!parsed.success || parsed.data.mapId !== this.mapId) {
      return undefined;
    }
    const { x, y, facing } = parsed.data;
    return { x, y, facing };
  }

  async save(positions: readonly PositionToSave[]): Promise<void> {
    if (positions.length === 0) {
      return;
    }
    // One round trip for everybody, and each write refreshes the TTL, so a
    // regular visitor's position never lapses.
    const batch = this.redis.multi();
    for (const position of positions) {
      batch.set(
        positionKey(position.userId, position.cohortId),
        JSON.stringify({
          mapId: this.mapId,
          x: position.x,
          y: position.y,
          facing: position.facing,
        }),
        'EX',
        this.ttlSeconds,
      );
    }
    const results = await batch.exec();
    const failed = results?.find(([err]) => err !== null);
    if (results === null || failed) {
      throw failed?.[0] ?? new Error('position save was aborted');
    }
  }

  async forget(userId: string, cohortId: string): Promise<void> {
    await this.redis.del(positionKey(userId, cohortId));
  }

  ready(timeoutMs: number): Promise<boolean> {
    if (this.redis.status === 'ready') {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.redis.off('ready', onReady);
        resolve(false);
      }, timeoutMs);
      this.redis.once('ready', onReady);
    });
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Already down: nothing is waiting to be written, so just let go.
      this.redis.disconnect();
    }
  }
}
