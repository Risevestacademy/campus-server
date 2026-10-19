import { randomUUID } from 'node:crypto';
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

/** One account's place in one cohort's campus, held by one connection. */
export interface Presence {
  userId: string;
  connectionId: string;
  cohortId: string;
  /**
   * The key of the space they are standing in, as the map draws it, or the
   * map's default space between drawn ones. Rewritten the moment they cross
   * into another space, and with every renewal.
   */
  spaceKey: string;
  /**
   * When the connection opened, in ms. The newest connection in a cohort
   * holds the account's place there.
   */
  since: number;
}

export interface PresenceEntry extends Presence {
  /** The world instance holding the connection. */
  instanceId: string;
}

/** A connection whose account entered the same cohort somewhere newer. */
export interface Displacement {
  userId: string;
  connectionId: string;
}

/**
 * Who is online, in which cohort and space, across every world instance — in
 * Redis, so that more than one instance can run, and so chat can work out
 * who to send to. One entry per account and cohort: somebody in two cohorts'
 * campuses at once is online in both.
 *
 * Each entry expires unless its instance keeps renewing it, so a crashed
 * instance's people drop out on their own.
 *
 * Like PositionStore, every method may fail, and Redis being down must never
 * keep anybody off the campus. Somebody whose entry could not be written is
 * missing from presence until the next renewal puts them back.
 */
export interface PresenceStore {
  readonly instanceId: string;
  /**
   * Takes the account's place in this connection's cohort, unless a newer
   * connection already holds it. A holder it takes the place of on another
   * instance is told to close (onDisplaced there).
   *
   * Resolves false when the place stays with a newer connection: two
   * connections opened at nearly the same moment on two instances can reach
   * Redis in either order, and the newer one wins whichever arrives first.
   * The caller closes its own connection then.
   */
  enter(presence: Presence): Promise<boolean>;
  /**
   * Keeps these connections present, putting back any entry that lapsed.
   * Returns those whose place a newer connection in the same cohort now
   * holds: the message telling this instance so may have been missed.
   */
  renew(presences: readonly Presence[]): Promise<Displacement[]>;
  /**
   * Rewrites one connection's entry for a move into another space. The same
   * write as a renewal, kept apart so a crossing has a name of its own.
   * Resolves false when a newer connection holds the place.
   */
  changeSpace(presence: Presence): Promise<boolean>;
  /** Only for connections still holding their account's place. */
  leave(presences: readonly Presence[]): Promise<void>;
  online(cohortId: string): Promise<PresenceEntry[]>;
  /** Hears about every displacement, including of connections held elsewhere. */
  onDisplaced(listener: (displaced: Displacement) => void): void;
  close(): Promise<void>;
}

/**
 * Which of two connections for one account and cohort is the newer: the one
 * opened later, and for two opened in the same millisecond, the one whose id
 * sorts last. Every instance and the Redis script decide it the same way, so
 * two of them can never each believe they hold the place.
 */
export function isNewer(
  a: Pick<Presence, 'since' | 'connectionId'>,
  b: Pick<Presence, 'since' | 'connectionId'>,
): boolean {
  return (
    a.since > b.since ||
    (a.since === b.since && a.connectionId > b.connectionId)
  );
}

export function presenceKey(userId: string, cohortId: string): string {
  return `world:presence:user:${userId}:cohort:${cohortId}`;
}

function keyOf({ userId, cohortId }: Presence): string {
  return presenceKey(userId, cohortId);
}

export function cohortPresenceKey(cohortId: string): string {
  return `world:presence:cohort:${cohortId}`;
}

export const DISPLACED_CHANNEL = 'world:presence:displaced';

/**
 * For one instance on its own: when REDIS_URL is unset, and nobody elsewhere
 * can hold a connection anyway. Nothing expires — a crash takes the memory
 * with it.
 */
export class MemoryPresenceStore implements PresenceStore {
  readonly instanceId = randomUUID();
  /** By presenceKey: one entry per account and cohort. */
  private readonly entries = new Map<string, Presence>();

  async enter(presence: Presence): Promise<boolean> {
    return this.claim(presence);
  }

  async changeSpace(presence: Presence): Promise<boolean> {
    return this.claim(presence);
  }

  async renew(presences: readonly Presence[]): Promise<Displacement[]> {
    return presences
      .filter((presence) => !this.claim(presence))
      .map(({ userId, connectionId }) => ({ userId, connectionId }));
  }

  /** Takes the place unless a newer connection holds it; true if it did. */
  private claim(presence: Presence): boolean {
    const held = this.entries.get(keyOf(presence));
    if (
      held &&
      held.connectionId !== presence.connectionId &&
      isNewer(held, presence)
    ) {
      return false;
    }
    this.entries.set(keyOf(presence), presence);
    return true;
  }

  async leave(presences: readonly Presence[]): Promise<void> {
    for (const presence of presences) {
      const key = keyOf(presence);
      if (this.entries.get(key)?.connectionId === presence.connectionId) {
        this.entries.delete(key);
      }
    }
  }

  async online(cohortId: string): Promise<PresenceEntry[]> {
    return [...this.entries.values()]
      .filter((presence) => presence.cohortId === cohortId)
      .map((presence) => ({ ...presence, instanceId: this.instanceId }));
  }

  onDisplaced(): void {
    // Nothing else can hold a connection, so nothing is ever displaced here.
  }

  async close(): Promise<void> {}
}

export function createPresenceStore(
  env: Env,
  log: FastifyBaseLogger,
  connect: ConnectRedis = connectRedis,
): PresenceStore {
  if (!env.REDIS_URL) {
    log.warn(
      'REDIS_URL is unset: presence is kept in memory, so run only one instance',
    );
    return new MemoryPresenceStore();
  }

  const redis = connect(env.REDIS_URL, FAIL_FAST);
  logOutages(
    redis,
    log,
    'presence',
    'presence will not be kept until it is back',
  );
  // Subscribed for as long as the process runs, so it waits out an outage
  // rather than failing fast, and resubscribes once Redis is back. Its
  // outages are already reported by the client above.
  const subscriber = connect(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', () => undefined);

  const store = new RedisPresenceStore(
    redis,
    subscriber,
    env.WORLD_PRESENCE_TTL_SECONDS,
    {
      onError: (err) => {
        log.warn({ err }, 'could not handle a presence message');
      },
    },
  );
  log.info({ instanceId: store.instanceId }, 'presence instance');
  return store;
}

/**
 * Writes this connection's entry, unless a newer connection holds the
 * account's place in this cohort, whether this is an entry or a renewal.
 * Newer is decided as isNewer does: later `since`, and for the same `since`,
 * the connection id that sorts last. Returns what it did, and the connection
 * it took the place of, if any, so that one can be told.
 *
 * The cohort index is a sorted set scored by when each entry lapses. It is
 * only an index: a reader confirms each member against the account's entry
 * for that cohort, so a member whose entry lapsed reads as nothing.
 */
const CLAIM = `
local held = redis.call('HMGET', KEYS[1], 'connectionId', 'instanceId', 'since')
local holder = held[1]
local userId, connectionId, instanceId, cohortId, spaceKey, since, ttl, lapses =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8]
if holder and holder ~= connectionId then
  local heldSince, mine = tonumber(held[3]) or 0, tonumber(since)
  if heldSince > mine or (heldSince == mine and holder > connectionId) then
    return {'newer'}
  end
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'connectionId', connectionId,
  'instanceId', instanceId, 'cohortId', cohortId, 'spaceKey', spaceKey,
  'since', since)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(lapses) - tonumber(ttl))
redis.call('ZADD', KEYS[2], lapses, userId)
redis.call('PEXPIRE', KEYS[2], ttl)
if holder and holder ~= connectionId then
  return {'took', holder, held[2]}
end
return {'held'}
`;

const RELEASE = `
if redis.call('HGET', KEYS[1], 'connectionId') == ARGV[2] then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return 0
`;

type ClaimReply = ['newer'] | ['held'] | ['took', string, string | null];

interface PresenceScripts {
  claimPresence(...args: (string | number)[]): Promise<ClaimReply>;
  releasePresence(...args: (string | number)[]): Promise<number>;
}

const storedEntry = z.object({
  connectionId: z.string(),
  instanceId: z.string(),
  cohortId: z.string(),
  spaceKey: z.string(),
  since: z.coerce.number().int(),
});

const displacedMessage = z.object({
  userId: z.string(),
  connectionId: z.string(),
});

export class RedisPresenceStore implements PresenceStore {
  readonly instanceId: string;
  private readonly ttlMs: number;
  private readonly scripts: PresenceScripts;
  private readonly listeners: ((displaced: Displacement) => void)[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly subscriber: Redis,
    ttlSeconds: number,
    {
      instanceId = randomUUID(),
      onError = () => undefined,
    }: { instanceId?: string; onError?: (err: unknown) => void } = {},
  ) {
    this.instanceId = instanceId;
    this.ttlMs = ttlSeconds * 1000;
    redis.defineCommand('claimPresence', { numberOfKeys: 2, lua: CLAIM });
    redis.defineCommand('releasePresence', { numberOfKeys: 2, lua: RELEASE });
    this.scripts = redis as unknown as PresenceScripts;

    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== DISPLACED_CHANNEL) return;
      try {
        const parsed = displacedMessage.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        for (const listener of this.listeners) listener(parsed.data);
      } catch (err) {
        onError(err);
      }
    });
    subscriber.subscribe(DISPLACED_CHANNEL).catch(onError);
  }

  async enter(presence: Presence): Promise<boolean> {
    return (await this.claim(presence)) !== 'newer';
  }

  async changeSpace(presence: Presence): Promise<boolean> {
    return (await this.claim(presence)) !== 'newer';
  }

  async renew(presences: readonly Presence[]): Promise<Displacement[]> {
    const outcomes = await Promise.all(
      presences.map((presence) => this.claim(presence)),
    );
    return presences
      .filter((_, i) => outcomes[i] === 'newer')
      .map(({ userId, connectionId }) => ({ userId, connectionId }));
  }

  async leave(presences: readonly Presence[]): Promise<void> {
    await Promise.all(
      presences.map(({ userId, connectionId, cohortId }) =>
        this.scripts.releasePresence(
          presenceKey(userId, cohortId),
          cohortPresenceKey(cohortId),
          userId,
          connectionId,
        ),
      ),
    );
  }

  async online(cohortId: string): Promise<PresenceEntry[]> {
    const userIds = await this.redis.zrangebyscore(
      cohortPresenceKey(cohortId),
      `(${Date.now()}`,
      '+inf',
    );
    if (userIds.length === 0) {
      return [];
    }
    const batch = this.redis.pipeline();
    for (const userId of userIds) {
      batch.hgetall(presenceKey(userId, cohortId));
    }
    const replies = (await batch.exec()) ?? [];

    const entries: PresenceEntry[] = [];
    for (const [i, [err, value]] of replies.entries()) {
      if (err) throw err;
      const parsed = storedEntry.safeParse(value);
      // Gone since the index was read.
      if (!parsed.success || parsed.data.cohortId !== cohortId) continue;
      entries.push({ userId: userIds[i] as string, ...parsed.data });
    }
    return entries;
  }

  onDisplaced(listener: (displaced: Displacement) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    // Nothing to flush, and a QUIT would queue behind an outage for good.
    this.subscriber.disconnect();
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async claim(presence: Presence): Promise<ClaimReply[0]> {
    const { userId, connectionId, cohortId, spaceKey, since } = presence;
    const reply = await this.scripts.claimPresence(
      presenceKey(userId, cohortId),
      cohortPresenceKey(cohortId),
      userId,
      connectionId,
      this.instanceId,
      cohortId,
      spaceKey,
      since,
      this.ttlMs,
      Date.now() + this.ttlMs,
    );
    // A holder on this instance was displaced here already, by the gateway.
    if (reply[0] === 'took' && reply[2] !== this.instanceId) {
      await this.redis.publish(
        DISPLACED_CHANNEL,
        JSON.stringify({ userId, connectionId: reply[1] }),
      );
    }
    return reply[0];
  }
}
