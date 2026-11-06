import { SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildWorld } from '../app.js';
import { MemoryPresenceStore, type Presence } from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  arrive,
  connect,
  deferred,
  env,
  leave,
  map,
  move,
  person,
  positionKey,
  positionsIn,
  quiet,
  store,
  token,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

describe('movement', () => {
  describe('one socket per account in each cohort', () => {
    const entryOf = (message: Record<string, unknown>) =>
      message.player as { userId: string; x: number; y: number };

    it('holds one socket for the account in a cohort, however many were opened', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      const third = await arrive(ada);
      await first.settled;
      await second.settled;

      expect(world.gateway.connections.forUser(ada)).toHaveLength(1);
      expect(
        world.gateway.players.in(COHORT).filter((p) => p.userId === ada),
      ).toHaveLength(1);

      await leave(third);
    });

    it('tells the socket it displaced, then closes it with 4000', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);

      await expect(
        waitFor(first, (m) => m.type === 'replaced'),
      ).resolves.toEqual({ type: 'replaced' });
      await expect(first.settled).resolves.toMatchObject({
        closeCode: 4000,
        closeReason: 'entered_elsewhere',
      });

      await leave(second);
    });

    /** The avatar must not blink out and back for everybody watching. */
    it('leaves the avatar where it stood, replacing within one cohort', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');

      const second = await arrive(ada);

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });

      await quiet();
      expect(
        watcher.messages.filter((m) => m.type === 'left' && m.userId === ada),
      ).toHaveLength(0);
      // The one from their original arrival, and no second one.
      expect(
        watcher.messages.filter(
          (m) => m.type === 'joined' && entryOf(m).userId === ada,
        ),
      ).toHaveLength(1);

      await leave(second);
      await leave(watcher);
    });

    /**
     * A second cohort is a second campus to stand in, not a move out of the
     * first: nobody is replaced, and nobody in the first sees them leave.
     */
    it('enters a second cohort without leaving the first', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      // Backend already knows where they stood last time.
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );

      const inBackend = await arrive(ada, 'cohort-backend');

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 3,
        y: 2,
        facing: 'left',
      });
      await expect(
        waitFor(
          backendWatcher,
          (m) => m.type === 'joined' && entryOf(m).userId === ada,
        ),
      ).resolves.toMatchObject({ player: { userId: ada, x: 3, y: 2 } });

      await quiet();
      expect(inFrontend.ws.readyState).toBe(WebSocket.OPEN);
      expect(inFrontend.messages.some((m) => m.type === 'replaced')).toBe(
        false,
      );
      expect(
        frontendWatcher.messages.some(
          (m) => m.type === 'left' && m.userId === ada,
        ),
      ).toBe(false);
      expect(world.gateway.connections.forUser(ada)).toHaveLength(2);
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
        x: 1,
        y: 0,
      });

      // And the first still walks.
      move(inFrontend, 'down', 2);
      await expect(
        waitFor(inFrontend, (m) => m.type === 'moveResult' && m.seq === 2),
      ).resolves.toMatchObject({ outcome: 'moved', player: { x: 1, y: 1 } });

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    it('saves each cohort where they stand in it', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      move(inFrontend, 'right', 1);
      move(inBackend, 'down', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      await waitFor(inBackend, (m) => m.type === 'moveResult');

      await leave(inFrontend);
      await leave(inBackend);

      await expect
        .poll(() =>
          store.positions.get(
            positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toEqual({ x: 1, y: 0, facing: 'right' });
      await expect
        .poll(() =>
          store.positions.get(
            positionKey({ userId: ada, cohortId: 'cohort-backend' }),
          ),
        )
        .toEqual({ x: 0, y: 1, facing: 'down' });
    });

    it('closing one cohort leaves the other standing', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      await leave(inFrontend);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      await quiet();
      expect(
        backendWatcher.messages.some(
          (m) => m.type === 'left' && m.userId === ada,
        ),
      ).toBe(false);
      expect(
        world.gateway.players.has({ userId: ada, cohortId: 'cohort-backend' }),
      ).toBe(true);
      expect(
        world.gateway.players.isRemembered({
          userId: ada,
          cohortId: 'cohort-frontend',
        }),
      ).toBe(true);

      await leave(inBackend);
      await leave(frontendWatcher);
      await leave(backendWatcher);
    });

    /** A suspension is about the account, so it reaches every campus it is in. */
    it('closes every cohort the account is in when it is suspended', async () => {
      const ada = person();
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      accounts.suspended.add(ada);

      for (const conn of [inFrontend, inBackend]) {
        await expect(conn.settled).resolves.toMatchObject({
          closeCode: 1008,
          closeReason: 'account_suspended',
        });
      }
      await expect(
        waitFor(backendWatcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();
      expect(world.gateway.connections.forUser(ada)).toEqual([]);

      accounts.suspended.delete(ada);
      await leave(backendWatcher);
    }, 15_000);

    /** The same, caught when another socket for the account is refused. */
    it('closes every cohort the account is in when a new socket is refused for suspension', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      // The heartbeat would close them too, a second later at most. The
      // refusal does it at once, before it answers the socket it refuses.
      const closedAt = (conn: { settled: Promise<unknown> }) =>
        conn.settled.then(() => Date.now());
      const frontendClosed = closedAt(inFrontend);
      const backendClosed = closedAt(inBackend);
      accounts.suspended.add(ada);
      const refused = connect(
        {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
        },
        'cohort-design',
      );

      const refusedAt = await closedAt(refused);
      for (const conn of [inFrontend, inBackend]) {
        await expect(conn.settled).resolves.toMatchObject({
          closeCode: 1008,
          closeReason: 'account_suspended',
        });
      }
      for (const closed of [frontendClosed, backendClosed]) {
        expect(await closed).toBeLessThanOrEqual(refusedAt + 100);
      }
      expect(world.gateway.connections.forUser(ada)).toEqual([]);

      accounts.suspended.delete(ada);
    }, 15_000);

    it('shows a changed look in every cohort they are in, each once', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');
      await quiet();

      accounts.changeLooks(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });
      await quiet();

      for (const conn of [
        frontendWatcher,
        backendWatcher,
        inFrontend,
        inBackend,
      ]) {
        expect(
          conn.messages.filter(
            (m) => m.type === 'appearance' && m.userId === ada,
          ),
        ).toHaveLength(1);
      }

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    /** The heartbeat asks the database about an account, not about each of its sockets. */
    it('reads an account once a sweep, however many cohorts it is in', async () => {
      const ada = person();
      const grace = person();
      const sockets = [
        await arrive(ada, 'cohort-frontend'),
        await arrive(ada, 'cohort-backend'),
        await arrive(ada, 'cohort-design'),
        await arrive(grace, 'cohort-frontend'),
      ];
      const find = vi.spyOn(accounts, 'find');
      try {
        // Across a few heartbeats: whatever number of sweeps ran, ada was
        // asked about exactly as often as grace, who has one socket.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const askedAbout = (userId: string) =>
          find.mock.calls.filter(([id]) => id === userId).length;
        expect(askedAbout(grace)).toBeGreaterThan(0);
        expect(askedAbout(ada)).toBe(askedAbout(grace));
      } finally {
        find.mockRestore();
      }
      for (const conn of sockets) await leave(conn);
    }, 15_000);

    /** A reconnect within the grace resumes in its own cohort, whatever else they are in. */
    it('resumes a cohort where they left it while standing in another', async () => {
      const ada = person();
      const inBackend = await arrive(ada, 'cohort-backend');
      const first = await arrive(ada, 'cohort-frontend');
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await expect
        .poll(() =>
          world.gateway.players.isRemembered({
            userId: ada,
            cohortId: 'cohort-frontend',
          }),
        )
        .toBe(true);

      const again = await arrive(ada, 'cohort-frontend');

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });
      await leave(again);
      await leave(inBackend);
    });

    it('keeps the avatar until the surviving socket closes', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;

      await quiet();
      expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
        true,
      );
      expect(
        watcher.messages.some((m) => m.type === 'left' && m.userId === ada),
      ).toBe(false);

      await leave(second);
      await expect(
        waitFor(watcher, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();

      await leave(watcher);
    });

    it('leaves the newest socket in charge of the avatar', async () => {
      const ada = person();
      const first = await arrive(ada);
      const second = await arrive(ada);
      await first.settled;

      move(second, 'down', 1);
      await expect(
        waitFor(second, (m) => m.type === 'moveResult'),
      ).resolves.toMatchObject({ outcome: 'moved', player: { x: 0, y: 1 } });

      await leave(second);
    });
  });

  /**
   * A dropped connection — a blip, or the server cutting it for sending too
   * fast or reading too slowly — comes back where it was, not at the spawn.
   */
  describe('reconnecting', () => {
    it('comes back where it stood, not at the spawn', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      move(first, 'down', 2);
      await waitFor(first, (m) => m.type === 'moveResult' && m.seq === 2);
      await leave(first);

      const again = await arrive(ada);

      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 1,
        facing: 'down',
      });
      await leave(again);
    });

    /**
     * The heartbeat sweep only sees accounts that are still connected. One
     * suspended after its socket had already dropped is caught when it next
     * tries to come back.
     */
    it('forgets a kept position once a reconnect is refused for suspension', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      // The client sees its close before the server has handled it.
      await expect
        .poll(() =>
          world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
        )
        .toBe(true);
      await expect
        .poll(() => store.positions.get(positionKey({ userId: ada })))
        .toEqual({ x: 1, y: 0, facing: 'right' });

      accounts.suspended.add(ada);
      const refused = connect({
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
      });
      await expect(refused.first).resolves.toMatchObject({
        message: 'account_suspended',
      });
      await refused.settled;
      expect(
        world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
      ).toBe(false);
      await expect
        .poll(() => store.positions.has(positionKey({ userId: ada })))
        .toBe(false);

      // Suspension lifted: welcome back, but at the spawn.
      accounts.suspended.delete(ada);
      const again = await arrive(ada);
      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(again);
    });

    it('forgets only the cohort the refusal named, leaving others', async () => {
      const ada = person();
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
        {
          x: 1,
          y: 1,
          facing: 'up',
        },
      );
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 2,
          y: 2,
          facing: 'down',
        },
      );

      accounts.suspended.add(ada);
      const refused = connect(
        {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
        },
        'cohort-frontend',
      );
      await refused.settled;

      await expect
        .poll(() =>
          store.positions.has(
            positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
          ),
        )
        .toBe(false);
      // The cohort not involved in the attempt is left alone.
      expect(
        store.positions.has(
          positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        ),
      ).toBe(true);
    });

    /** Gone from everybody's screen at once, and back in the same place. */
    it('shows others a departure, then an arrival where it left', async () => {
      const ada = person();
      const watcher = await arrive(person());
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await waitFor(watcher, (m) => m.type === 'left' && m.userId === ada);

      const again = await arrive(ada);

      await expect(
        waitFor(
          watcher,
          (m) => m.type === 'joined' && (m.player as { x: number }).x === 1,
        ),
      ).resolves.toMatchObject({ player: { userId: ada, x: 1, y: 0 } });
      await leave(again);
      await leave(watcher);
    });
  });

  /**
   * A second tab refused for suspension, while the first is still open. The
   * open tab must be closed through the normal lifecycle — not have its
   * player removed from under it, which left it registered with nobody
   * standing for it. Whichever notices first, the refusal or the sweep, the
   * outcome is the same, so this does not depend on timing.
   */
  it('closes an open tab properly when another tab is refused for suspension', async () => {
    const ada = person();
    const open = await arrive(ada);
    const watcher = await arrive(person());

    accounts.suspended.add(ada);
    const refused = connect({
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
    });

    await expect(refused.settled).resolves.toMatchObject({ closeCode: 1008 });
    await expect(open.settled).resolves.toMatchObject({
      closeCode: 1008,
      closeReason: 'account_suspended',
    });
    await expect(
      waitFor(watcher, (m) => m.type === 'left'),
    ).resolves.toMatchObject({
      userId: ada,
    });
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );
    expect(world.gateway.connections.forUser(ada)).toEqual([]);

    await leave(watcher);
  }, 15_000);

  /** Whichever way a socket is dropped, its player must not be left standing. */
  it('removes the player when a suspension closes their socket', async () => {
    const ada = person();
    const conn = await arrive(ada);
    const watcher = await arrive(person());

    accounts.suspended.add(ada);

    await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
    await expect(
      waitFor(watcher, (m) => m.type === 'left'),
    ).resolves.toMatchObject({
      userId: ada,
    });
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );
    // Access taken away: nothing kept to come back to.
    expect(
      world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
    ).toBe(false);

    await leave(watcher);
  }, 15_000);
});

/** A redeploy must not send everybody back to the spawn. */
describe('shutdown', () => {
  it('saves everybody still here and takes them out of presence before closing their sockets', async () => {
    const saved = new Map<string, unknown>();
    const own = await buildWorld({
      env,
      accounts,
      positions: {
        ...store,
        save: async (players) => {
          for (const { userId, x, y, facing } of players)
            saved.set(userId, { x, y, facing });
        },
      },
      presence: new MemoryPresenceStore(),
      map,
    });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
      {
        headers: {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, 'leaving-1')}`,
        },
      },
    );
    const closed = new Promise((resolve) => ws.on('close', resolve));
    await new Promise((resolve) => ws.on('message', resolve));
    expect(await own.presence.online(COHORT)).toHaveLength(1);

    await own.gateway.stop();

    expect(saved.get('leaving-1')).toEqual({ x: 0, y: 0, facing: 'down' });
    expect(await own.presence.online(COHORT)).toEqual([]);
    await closed;
    await own.app.close();
  });

  /**
   * Shutdown takes everybody out of presence before it closes their sockets,
   * and their moves are still read meanwhile. One that crosses into another
   * space then must not write their entry back, or they show online for a
   * whole presence lifetime with nothing left to remove them.
   */
  it('does not put back a presence entry for a move made while shutting down', async () => {
    const memory = new MemoryPresenceStore();
    const removed = deferred<void>();
    const release = deferred<void>();
    const holding = {
      instanceId: memory.instanceId,
      enter: (entry: Presence) => memory.enter(entry),
      renew: (entries: readonly Presence[]) => memory.renew(entries),
      changeSpace: (entry: Presence) => memory.changeSpace(entry),
      setStatus: (entry: Presence) => memory.setStatus(entry),
      online: (cohortId: string) => memory.online(cohortId),
      onDisplaced: () => undefined,
      close: async () => undefined,
      // Removed at once, as Redis would, but answered only when let go.
      leave: async (entries: readonly Presence[]) => {
        await memory.leave(entries);
        removed.resolve();
        await release.promise;
      },
    };
    const own = await buildWorld({
      env,
      accounts,
      positions: store,
      presence: holding,
      map,
    });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = own.app.server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket?cohortId=${COHORT}`,
      {
        headers: {
          origin: ORIGIN,
          cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, `leaving-${randomUUID()}`)}`,
        },
      },
    );
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    const closed = new Promise((resolve) => ws.on('close', resolve));
    const answered = (seq: number) =>
      expect
        .poll(() =>
          messages.some((m) => m.type === 'moveResult' && m.seq === seq),
        )
        .toBe(true);
    await expect
      .poll(() => messages.some((m) => m.type === 'snapshot'))
      .toBe(true);
    for (const seq of [1, 2]) {
      ws.send(JSON.stringify({ type: 'move', direction: 'right', seq }));
      await answered(seq);
      await new Promise((resolve) => setTimeout(resolve, env.WORLD_STEP_MS));
    }

    const stopped = own.gateway.stop();
    await removed.promise;
    // Into the library, while shutdown's removal is still being answered.
    ws.send(JSON.stringify({ type: 'move', direction: 'right', seq: 3 }));
    await answered(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.resolve();
    await stopped;

    await expect(memory.online(COHORT)).resolves.toEqual([]);
    await closed;
    await own.app.close();
  });
});
