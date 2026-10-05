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

/** One account's place in the world, held by one connection. */
export interface Presence {
  userId: string;
  connectionId: string;
  cohortId: string;
  /** Unset until spaces exist (W6). */
  spaceId?: string;
  /** When the connection opened, in ms. The newest connection holds the place. */
  since: number;
}

export interface PresenceEntry extends Presence {
  /** The world instance holding the connection. */
  instanceId: string;
}

/** A connection whose account entered the campus somewhere newer. */
export interface Displacement {
  userId: string;
  connectionId: string;
}

/**
 * Who is online, in which cohort and space, across every world instance — in
 * Redis, so that more than one instance can run, and so chat can work out
 * who to send to.
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
   * Takes the account's place for this connection, whoever held it. A holder
   * on another instance is told to close (onDisplaced there).
   */
  enter(presence: Presence): Promise<void>;
  /**
   * Keeps these connections present, putting back any entry that lapsed.
   * Returns those whose account a newer connection now holds: the message
   * telling this instance so may have been missed.
   */
  renew(presences: readonly Presence[]): Promise<Displacement[]>;
  /** Only for connections still holding their account's place. */
  leave(presences: readonly Presence[]): Promise<void>;
  online(cohortId: string): Promise<PresenceEntry[]>;
  /** Hears about every displacement, including of connections held elsewhere. */
  onDisplaced(listener: (displaced: Displacement) => void): void;
  close(): Promise<void>;
}

export function presenceKey(userId: string): string {
  return `world:presence:user:${userId}`;
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
  private readonly byUser = new Map<string, Presence>();

  async enter(presence: Presence): Promise<void> {
    this.byUser.set(presence.userId, presence);
  }

  async renew(presences: readonly Presence[]): Promise<Displacement[]> {
    const displaced: Displacement[] = [];
    for (const presence of presences) {
      const { userId, connectionId } = presence;
      const held = this.byUser.get(userId);
      if (
        held &&
        held.connectionId !== connectionId &&
        held.since > presence.since
      ) {
        displaced.push({ userId, connectionId });
      } else {
        this.byUser.set(userId, presence);
      }
    }
    return displaced;
  }

  async leave(presences: readonly Presence[]): Promise<void> {
    for (const { userId, connectionId } of presences) {
      if (this.byUser.get(userId)?.connectionId === connectionId) {
        this.byUser.delete(userId);
      }
    }
  }

  async online(cohortId: string): Promise<PresenceEntry[]> {
    return [...this.byUser.values()]
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
 * account and this is only a renewal. Returns what it did, and the
 * connection it took the place of, if any, so that one can be told.
 *
 * The cohort index is a sorted set scored by when each entry lapses. It is
 * only an index: a reader confirms each member against the account's entry,
 * so a member left behind by somebody changing cohort reads as nothing.
 */
const CLAIM = `
local held = redis.call('HMGET', KEYS[1], 'connectionId', 'instanceId', 'since')
local holder = held[1]
local userId, connectionId, instanceId, cohortId, spaceId, since, ttl, lapses, force =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8], ARGV[9]
if holder and holder ~= connectionId and force ~= '1'
  and (tonumber(held[3]) or 0) > tonumber(since) then
  return {'newer'}
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'connectionId', connectionId,
  'instanceId', instanceId, 'cohortId', cohortId, 'since', since)
if spaceId ~= '' then
  redis.call('HSET', KEYS[1], 'spaceId', spaceId)
end
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
  spaceId: z.string().optional(),
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

  async enter(presence: Presence): Promise<void> {
    await this.claim(presence, true);
  }

  async renew(presences: readonly Presence[]): Promise<Displacement[]> {
    const outcomes = await Promise.all(
      presences.map((presence) => this.claim(presence, false)),
    );
    return presences
      .filter((_, i) => outcomes[i] === 'newer')
      .map(({ userId, connectionId }) => ({ userId, connectionId }));
  }

  async leave(presences: readonly Presence[]): Promise<void> {
    await Promise.all(
      presences.map(({ userId, connectionId, cohortId }) =>
        this.scripts.releasePresence(
          presenceKey(userId),
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
    for (const userId of userIds) batch.hgetall(presenceKey(userId));
    const replies = (await batch.exec()) ?? [];

    const entries: PresenceEntry[] = [];
    for (const [i, [err, value]] of replies.entries()) {
      if (err) throw err;
      const parsed = storedEntry.safeParse(value);
      // Gone since the index was read, or moved to another cohort.
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

  private async claim(
    presence: Presence,
    force: boolean,
  ): Promise<ClaimReply[0]> {
    const { userId, connectionId, cohortId, spaceId, since } = presence;
    const reply = await this.scripts.claimPresence(
      presenceKey(userId),
      cohortPresenceKey(cohortId),
      userId,
      connectionId,
      this.instanceId,
      cohortId,
      spaceId ?? '',
      since,
      this.ttlMs,
      Date.now() + this.ttlMs,
      force ? '1' : '0',
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
