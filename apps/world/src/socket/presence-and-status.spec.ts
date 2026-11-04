import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import WebSocket from 'ws';

import { buildWorld, type World } from '../app.js';
import { loadEnv } from '../infra/env.js';
import { STEP_BURST } from '../movement/players.js';
import { DISPLACED_CHANNEL, MemoryPresenceStore } from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  arrive,
  connect,
  env,
  leave,
  map,
  move,
  person,
  positionKey,
  presence,
  presenceKeyOf,
  quiet,
  step,
  store,
  token,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

describe('movement', () => {
  describe('presence', () => {
    const connectionIdOf = async (conn: ReturnType<typeof connect>) =>
      (await waitFor(conn, (m) => m.type === 'welcome')).connectionId as string;

    it('records who is online, and in which cohort, while their socket is open', async () => {
      const ada = person();
      const conn = await arrive(ada, 'cohort-frontend');
      const connectionId = await connectionIdOf(conn);

      await expect
        .poll(() =>
          presence.entries.get(
            presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toMatchObject({ connectionId, cohortId: 'cohort-frontend' });

      await leave(conn);
      await expect
        .poll(() =>
          presence.entries.has(
            presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toBe(false);
    });

    /**
     * One move, answered, then a full step's time, so the next has its
     * allowance back. Any shorter and a long walk runs out of steps, sooner
     * the faster the machine answers.
     */
    const crossingsOf = (userId: string) =>
      presence.crossings
        .filter((entry) => entry.userId === userId)
        .map((entry) => entry.spaceKey);

    it('records the space they arrive in', async () => {
      const ada = person();
      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })))
        .toMatchObject({ spaceKey: DEFAULT_SPACE_KEY });
      await leave(conn);
    });

    /** Somebody back where they stood last time is in that place's space. */
    it('records the space of a saved position they come back to', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });

      const conn = await arrive(ada);

      await expect
        .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })))
        .toMatchObject({ spaceKey: 'library' });
      await leave(conn);
    });

    /** Right the moment they cross; a step within a space costs no write. */
    it('writes the space as they cross into it and out of it, and not for steps within it', async () => {
      const ada = person();
      const conn = await arrive(ada);

      // The third step right is into the library.
      for (const seq of [1, 2, 3]) await step(conn, 'right', seq);
      expect(crossingsOf(ada)).toEqual(['library']);
      expect(
        presence.entries.get(presenceKeyOf({ userId: ada })),
      ).toMatchObject({
        spaceKey: 'library',
      });

      // Further in: still the library, no write.
      await step(conn, 'right', 4);
      await step(conn, 'down', 5);
      expect(crossingsOf(ada)).toEqual(['library']);

      // Back out the way they came.
      await step(conn, 'up', 6);
      await step(conn, 'left', 7);
      await step(conn, 'left', 8);
      expect(crossingsOf(ada)).toEqual(['library', DEFAULT_SPACE_KEY]);

      await leave(conn);
    });

    /** Into a wall, or faster than walking allows: they stay put, so no write. */
    it('writes nothing for a move that goes nowhere', async () => {
      const ada = person();
      const conn = await arrive(ada);

      await step(conn, 'down', 1);
      await expect(step(conn, 'down', 2)).resolves.toMatchObject({
        outcome: 'blocked',
      });

      // Beside the library's door, then out of steps for a moment: the step
      // that would cross is refused, and nothing is written for it.
      await step(conn, 'up', 3);
      await step(conn, 'right', 4);
      await step(conn, 'right', 5);
      // A whole burst against the top edge spends every step there is.
      for (let i = 0; i < STEP_BURST; i += 1) move(conn, 'up', 6 + i);
      const crossing = 6 + STEP_BURST;
      move(conn, 'right', crossing);
      await expect(
        waitFor(conn, (m) => m.type === 'moveResult' && m.seq === crossing),
      ).resolves.toMatchObject({ outcome: 'too_fast' });
      await quiet();

      expect(crossingsOf(ada)).toEqual([]);
      await leave(conn);
    });

    /** A crossing write can be the first to learn the place moved on. */
    it('closes a socket whose change of space finds a newer one holding its place', async () => {
      const ada = person();
      const conn = await arrive(ada);
      presence.newerOnCrossing.add(await connectionIdOf(conn));

      for (const seq of [1, 2]) await step(conn, 'right', seq);
      move(conn, 'right', 3);

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
    });

    it('puts a change of space that could not be written right at the next renewal', async () => {
      const ada = person();
      const conn = await arrive(ada);
      presence.failCrossings = true;
      try {
        for (const seq of [1, 2, 3]) await step(conn, 'right', seq);
        expect(crossingsOf(ada)).toEqual(['library']);
        expect(
          presence.entries.get(presenceKeyOf({ userId: ada })),
        ).toMatchObject({
          spaceKey: DEFAULT_SPACE_KEY,
        });

        await expect
          .poll(() => presence.entries.get(presenceKeyOf({ userId: ada })), {
            timeout: 3_000,
          })
          .toMatchObject({ spaceKey: 'library' });
      } finally {
        presence.failCrossings = false;
      }
      await leave(conn);
    });

    it('keeps the replacing socket present once the one it replaced closes', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const connectionId = await connectionIdOf(second);
      await first.settled;

      await quiet();
      expect(
        presence.entries.get(presenceKeyOf({ userId: ada }))?.connectionId,
      ).toBe(connectionId);

      await leave(second);
    });

    it('closes a socket whose account entered the campus on another instance', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const conn = await arrive(ada);

      presence.displace({
        userId: ada,
        connectionId: await connectionIdOf(conn),
      });

      await expect(
        waitFor(conn, (m) => m.type === 'replaced'),
      ).resolves.toEqual({ type: 'replaced' });
      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
      // The avatar now stands on the other instance.
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
        false,
      );

      await leave(watcher);
    });

    it('ignores a displacement of a socket already replaced here', async () => {
      const ada = person();
      const first = await arrive(ada);
      const firstId = await connectionIdOf(first);
      const second = await arrive(ada);
      await first.settled;

      presence.displace({ userId: ada, connectionId: firstId });

      await quiet();
      expect(second.ws.readyState).toBe(WebSocket.OPEN);
      await leave(second);
    });

    /**
     * A newer connection to the same cohort on another instance reached Redis
     * first. This one does not take its place: it closes as if displaced.
     */
    it('closes a socket whose entry finds a newer one holding the place', async () => {
      const ada = person();
      const watcher = await arrive(person());
      presence.newerElsewhere = true;

      const conn = await arrive(ada);

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
      expect(conn.messages).toContainEqual({ type: 'replaced' });
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(presence.entries.has(presenceKeyOf({ userId: ada }))).toBe(false);
      await leave(watcher);
    });

    /** The message from the other instance can be missed; the renewal cannot. */
    it('closes a socket a renewal finds displaced', async () => {
      const ada = person();
      const conn = await arrive(ada);

      presence.heldElsewhere.add(await connectionIdOf(conn));

      await expect(conn.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });
    });

    it('lets somebody in while presence cannot be written, and records them once it can', async () => {
      const ada = person();
      presence.failing = true;

      const conn = await arrive(ada);
      await quiet();
      expect(presence.entries.has(presenceKeyOf({ userId: ada }))).toBe(false);

      presence.failing = false;
      await expect
        .poll(() => presence.entries.has(presenceKeyOf({ userId: ada })), {
          timeout: 3_000,
        })
        .toBe(true);
      await leave(conn);
    });
  });

  describe('status', () => {
    const setStatus = (conn: { ws: WebSocket }, status: string) =>
      conn.ws.send(JSON.stringify({ type: 'setStatus', status }));
    const statusesIn = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages.filter((m) => m.type === 'statusChanged');

    it('starts everybody available', async () => {
      const ada = person();
      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual([
        expect.objectContaining({ userId: ada, status: 'available' }),
      ]);
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('available');

      await leave(conn);
    });

    it('tells a status chosen to everybody in the cohort, them included, and nobody in another', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const sameCohort = await arrive(person(), 'cohort-frontend');
      const otherCohort = await arrive(person(), 'cohort-backend');

      setStatus(inFrontend, 'busy');

      const changed = { type: 'statusChanged', userId: ada, status: 'busy' };
      await expect(
        waitFor(sameCohort, (m) => m.type === 'statusChanged'),
      ).resolves.toEqual(changed);
      await expect(
        waitFor(inFrontend, (m) => m.type === 'statusChanged'),
      ).resolves.toEqual(changed);
      await expect
        .poll(
          () =>
            presence.entries.get(
              presenceKeyOf({ userId: ada, cohortId: 'cohort-frontend' }),
            )?.status,
        )
        .toBe('busy');
      await quiet();
      expect(statusesIn(otherCohort)).toEqual([]);

      await leave(inFrontend);
      await leave(sameCohort);
      await leave(otherCohort);
    });

    it('keeps a status to the cohort it was chosen in, for somebody in two', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      const backendWatcher = await arrive(person(), 'cohort-backend');

      setStatus(inFrontend, 'busy');

      await waitFor(inFrontend, (m) => m.type === 'statusChanged');
      await quiet();
      expect(statusesIn(inBackend)).toEqual([]);
      expect(statusesIn(backendWatcher)).toEqual([]);
      expect(
        presence.entries.get(
          presenceKeyOf({ userId: ada, cohortId: 'cohort-backend' }),
        )?.status,
      ).toBe('available');

      await leave(inFrontend);
      await leave(inBackend);
      await leave(backendWatcher);
    });

    it('sends nothing for choosing the status already shown', async () => {
      const conn = await arrive(person());
      const watcher = await arrive(person());

      setStatus(conn, 'available');

      await quiet();
      expect(statusesIn(watcher)).toEqual([]);
      expect(statusesIn(conn)).toEqual([]);
      await leave(conn);
      await leave(watcher);
    });

    it('shows a later arrival the status as it is now', async () => {
      const ada = person();
      const conn = await arrive(ada);
      setStatus(conn, 'away');
      await waitFor(conn, (m) => m.type === 'statusChanged');

      const later = await arrive(person());

      const snapshot = await waitFor(later, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, status: 'away' }),
      );
      await leave(conn);
      await leave(later);
    });

    it('forgets the status once they disconnect', async () => {
      const ada = person();
      const first = await arrive(ada);
      setStatus(first, 'busy');
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('busy');

      await leave(first);
      await expect
        .poll(() => presence.entries.has(presenceKeyOf({ userId: ada })))
        .toBe(false);
      const again = await arrive(ada);

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual([
        expect.objectContaining({ userId: ada, status: 'available' }),
      ]);
      await leave(again);
    });

    it('keeps the status chosen in a tab another replaces in the same cohort', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      setStatus(first, 'busy');
      await waitFor(watcher, (m) => m.type === 'statusChanged');

      const second = await arrive(ada);
      await first.settled;

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, status: 'busy' }),
      );
      await quiet();
      expect(statusesIn(watcher)).toHaveLength(1);
      await expect
        .poll(
          () => presence.entries.get(presenceKeyOf({ userId: ada }))?.status,
        )
        .toBe('busy');

      await leave(second);
      await leave(watcher);
    });

    it('rejects a status that is not one of the three', async () => {
      const conn = await arrive(person());

      setStatus(conn, 'invisible');

      await expect(
        waitFor(conn, (m) => m.type === 'error'),
      ).resolves.toMatchObject({ code: 'BAD_MESSAGE' });
      await leave(conn);
    });
  });
});

/**
 * In a world of its own, idle after a second: in the shared one, everybody in
 * every other test would go away under it.
 */
describe('going away while idle', () => {
  const AWAY = { timeout: 5_000 };
  let idle: World;
  let idleUrl: string;
  let nextUser = 0;

  beforeAll(async () => {
    idle = await buildWorld({
      env: { ...env, WORLD_AWAY_AFTER_SECONDS: 1 },
      accounts,
      positions: store,
      presence: new MemoryPresenceStore(),
      map,
    });
    await idle.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = idle.app.server.address() as AddressInfo;
    idleUrl = `ws://127.0.0.1:${port}/socket`;
  });

  afterAll(async () => {
    await idle.gateway.stop();
    await idle.app.close();
  });

  async function arrive(cohortId = COHORT) {
    const userId = `idler-${++nextUser}`;
    const conn = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
      },
      cohortId,
      idleUrl,
    );
    await waitFor(conn, (m) => m.type === 'snapshot');
    return { ...conn, userId };
  }

  async function leave(...conns: ReturnType<typeof connect>[]) {
    for (const conn of conns) {
      conn.ws.close();
      await conn.settled;
    }
  }

  /** The statuses one person was shown as, in the order they arrived. */
  const statusesOf = (
    conn: { messages: Record<string, unknown>[] },
    userId: string,
  ) =>
    conn.messages
      .filter((m) => m.type === 'statusChanged' && m.userId === userId)
      .map((m) => m.status);

  it('tells each arrival how long they may be idle', async () => {
    const conn = await arrive();

    expect(conn.messages[0]).toMatchObject({
      type: 'welcome',
      awayAfterSeconds: 1,
    });
    await leave(conn);
  });

  it('shows somebody idle as away to their cohort, them included, and back once they move', async () => {
    const ada = await arrive('cohort-frontend');
    const watcher = await arrive('cohort-frontend');
    const elsewhere = await arrive('cohort-backend');

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['away']);
    expect(statusesOf(ada, ada.userId)).toEqual(['away']);
    await expect
      .poll(async () =>
        (await idle.presence.online('cohort-frontend')).find(
          (entry) => entry.userId === ada.userId,
        ),
      )
      .toMatchObject({ status: 'away' });

    ada.ws.send(JSON.stringify({ type: 'move', direction: 'right', seq: 1 }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['away', 'available']);
    await expect
      .poll(async () =>
        (await idle.presence.online('cohort-frontend')).find(
          (entry) => entry.userId === ada.userId,
        ),
      )
      .toMatchObject({ status: 'available' });
    expect(statusesOf(elsewhere, ada.userId)).toEqual([]);

    await leave(ada, watcher, elsewhere);
  });

  it('brings them back to the status they chose on `active`', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    ada.ws.send(JSON.stringify({ type: 'setStatus', status: 'busy' }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away']);

    ada.ws.send(JSON.stringify({ type: 'active' }));

    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away', 'busy']);
    await leave(ada, watcher);
  });

  it('does not count a ping as activity', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    const pinging = setInterval(
      () => ada.ws.send(JSON.stringify({ type: 'ping' })),
      100,
    );

    try {
      await expect
        .poll(() => statusesOf(watcher, ada.userId), AWAY)
        .toEqual(['away']);
    } finally {
      clearInterval(pinging);
    }
    await leave(ada, watcher);
  });

  it('brings back an idle tab replaced by a new one in the same cohort', async () => {
    const ada = await arrive();
    const watcher = await arrive();
    ada.ws.send(JSON.stringify({ type: 'setStatus', status: 'busy' }));
    await expect
      .poll(() => statusesOf(watcher, ada.userId), AWAY)
      .toEqual(['busy', 'away']);

    const second = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada.userId)}`,
      },
      COHORT,
      idleUrl,
    );
    const snapshot = await waitFor(second, (m) => m.type === 'snapshot');

    expect(second.messages[0]).toMatchObject({ type: 'welcome' });
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada.userId, status: 'busy' }),
    );
    await expect
      .poll(() => statusesOf(watcher, ada.userId))
      .toEqual(['busy', 'away', 'busy']);
    await ada.settled;
    await leave(second, watcher);
  });
});

/**
 * Two instances sharing one Redis, as production will run them. Needs a real
 * Redis: see WORLD_TEST_REDIS_URL in presence.spec.ts.
 */
const redisUrl = process.env.WORLD_TEST_REDIS_URL;

describe.skipIf(!redisUrl)('across instances', () => {
  const shared = loadEnv({
    AUTH_SESSION_SECRET: SECRET,
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://unused',
    CORS_ORIGINS: ORIGIN,
    REDIS_URL: redisUrl,
    FF_LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  const cohortId = `cohort-${randomUUID()}`;
  const instances: World[] = [];
  let redis: Redis;

  async function instance(): Promise<World> {
    const own = await buildWorld({
      env: shared,
      accounts,
      positions: store,
    });
    instances.push(own);
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    return own;
  }

  function enter(own: World, cookie: string) {
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${cohortId}`,
      { headers: { origin: ORIGIN, cookie } },
    );
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    const closed = new Promise<[number, string]>((resolve) =>
      ws.on('close', (code, reason) => resolve([code, reason.toString()])),
    );
    return { ws, messages, closed };
  }

  beforeAll(() => {
    redis = new Redis(redisUrl as string);
  });

  afterAll(async () => {
    for (const own of instances) {
      await own.gateway.stop();
      await own.app.close();
      await own.presence.close();
      await own.positions.close();
    }
    await redis.quit();
  });

  it('closes the socket on one instance when the account enters on another', async () => {
    const first = await instance();
    const second = await instance();
    // Both listening before anybody enters, or the message has nobody to hear it.
    await expect
      .poll(async () => {
        const [, count] = (await redis.pubsub('NUMSUB', DISPLACED_CHANNEL)) as [
          string,
          number,
        ];
        return count;
      })
      .toBeGreaterThanOrEqual(2);
    const userId = `elsewhere-${randomUUID()}`;
    const cookie = `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`;

    const onFirst = enter(first, cookie);
    await expect
      .poll(() => onFirst.messages.some((m) => m.type === 'snapshot'))
      .toBe(true);
    const onSecond = enter(second, cookie);

    await expect(onFirst.closed).resolves.toEqual([4000, 'entered_elsewhere']);
    expect(onFirst.messages).toContainEqual({ type: 'replaced' });
    expect(first.gateway.players.has({ userId, cohortId })).toBe(false);
    const welcome = onSecond.messages.find((m) => m.type === 'welcome');
    await expect(second.presence.online(cohortId)).resolves.toEqual([
      expect.objectContaining({
        userId,
        connectionId: welcome?.connectionId,
        instanceId: second.presence.instanceId,
      }),
    ]);

    onSecond.ws.close();
    await onSecond.closed;
    await expect.poll(() => second.presence.online(cohortId)).toEqual([]);
  });
});
