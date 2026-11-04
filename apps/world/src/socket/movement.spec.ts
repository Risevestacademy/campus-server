import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import {} from '@campus/space-access';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { STEP_BURST } from '../movement/players.js';
import {} from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  WALL,
  accounts,
  arrive,
  connect,
  deferred,
  leave,
  move,
  person,
  positionKey,
  positionsIn,
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
  it('shows an arrival the map and everybody on it, themselves included', async () => {
    const ada = person();
    const grace = person();
    const first = await arrive(ada);
    const second = await arrive(grace);

    const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
    // Which map and version, so the client loads the one enforced here.
    expect(snapshot).toMatchObject({
      map: { id: 'campus', version: 'v-test', width: 5, height: 5 },
    });
    expect(positionsIn(snapshot)).toEqual(
      expect.arrayContaining([
        { userId: ada, x: 0, y: 0, facing: 'down' },
        { userId: grace, x: 0, y: 0, facing: 'down' },
      ]),
    );

    await leave(first);
    await leave(second);
  });

  it('tells everybody already here that somebody arrived', async () => {
    const ada = person();
    const grace = person();
    const first = await arrive(ada);
    const second = await arrive(grace);

    await expect(waitFor(first, (m) => m.type === 'joined')).resolves.toEqual({
      type: 'joined',
      player: {
        userId: grace,
        x: 0,
        y: 0,
        facing: 'down',
        displayName: null,
        spriteKey: null,
        status: 'available',
        spaceKey: DEFAULT_SPACE_KEY,
      },
    });
    // Learns about themselves from the snapshot, not from a joined.
    await quiet();
    expect(second.messages.some((m) => m.type === 'joined')).toBe(false);

    await leave(first);
    await leave(second);
  });

  describe('what to draw for each player', () => {
    it('tells an arrival their own sprite and name in the welcome', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });

      const conn = await arrive(ada);

      await expect(
        waitFor(conn, (m) => m.type === 'welcome'),
      ).resolves.toMatchObject({
        userId: ada,
        displayName: 'Ada L.',
        spriteKey: 'placeholder-2',
      });
      await leave(conn);
    });

    it('sends everybody’s sprite and name with the snapshot and with joined', async () => {
      const ada = person();
      const grace = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      accounts.looks.set(grace, {
        displayName: 'Grace H.',
        spriteKey: 'placeholder-3',
      });
      const first = await arrive(ada);
      const second = await arrive(grace);

      await expect(
        waitFor(first, (m) => m.type === 'joined'),
      ).resolves.toMatchObject({
        player: {
          userId: grace,
          displayName: 'Grace H.',
          spriteKey: 'placeholder-3',
        },
      });
      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: ada,
            displayName: 'Ada L.',
            spriteKey: 'placeholder-1',
          }),
          expect.objectContaining({
            userId: grace,
            displayName: 'Grace H.',
            spriteKey: 'placeholder-3',
          }),
        ]),
      );

      await leave(first);
      await leave(second);
    });

    it('keeps moves to the position alone', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      const walker = await arrive(ada);
      const watcher = await arrive(person());

      move(walker, 'right', 1);

      const moved = await waitFor(watcher, (m) => m.type === 'moved');
      expect(moved.players).toEqual([
        { userId: ada, x: 1, y: 0, facing: 'right' },
      ]);

      await leave(walker);
      await leave(watcher);
    });

    /**
     * campus-api notifies world in the same transaction as the save, so a
     * change reaches everybody in the cohort, its owner's own tab included,
     * without anybody leaving or entering.
     */
    it('shows a changed sprite to the whole cohort as soon as it is saved', async () => {
      const ada = person();
      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-1',
      });
      const own = await arrive(ada);
      const watcher = await arrive(person());
      const elsewhere = await arrive(person(), 'cohort-backend');
      await quiet();

      accounts.changeLooks(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-4',
      });

      // Well inside one heartbeat, so it is the notification that did it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const expected = {
        type: 'appearance',
        userId: ada,
        displayName: 'Ada L.',
        spriteKey: 'placeholder-4',
      };
      expect(watcher.messages).toContainEqual(expected);
      expect(own.messages).toContainEqual(expected);
      await quiet();
      expect(elsewhere.messages.some((m) => m.type === 'appearance')).toBe(
        false,
      );

      // And whoever comes in next draws the new one from the snapshot.
      const late = await arrive(person());
      const snapshot = await waitFor(late, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, spriteKey: 'placeholder-4' }),
      );

      await leave(own);
      await leave(watcher);
      await leave(elsewhere);
      await leave(late);
    });

    it('says nothing when what is drawn did not change', async () => {
      const ada = person();
      const looks = { displayName: 'Ada L.', spriteKey: 'placeholder-2' };
      accounts.looks.set(ada, looks);
      const own = await arrive(ada);
      const watcher = await arrive(person());
      await quiet();

      accounts.changeLooks(ada, { ...looks });
      await quiet();

      expect(watcher.messages.some((m) => m.type === 'appearance')).toBe(false);
      await leave(own);
      await leave(watcher);
    });

    /**
     * A notification sent while this process was reconnecting to the
     * database is lost. The heartbeat reads every account anyway, and shows
     * the change then.
     */
    it('catches a change it was never told of on the next heartbeat', async () => {
      const ada = person();
      const own = await arrive(ada);
      const watcher = await arrive(person());
      await quiet();

      accounts.looks.set(ada, {
        displayName: 'Ada L.',
        spriteKey: 'placeholder-3',
      });

      await expect(
        waitFor(watcher, (m) => m.type === 'appearance'),
      ).resolves.toMatchObject({ userId: ada, spriteKey: 'placeholder-3' });
      await leave(own);
      await leave(watcher);
    });
  });

  it('stops somebody at a wall, facing it', async () => {
    const ada = person();
    const walker = await arrive(ada);

    move(walker, 'down', 1);
    move(walker, 'down', 2);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 2),
    ).resolves.toEqual({
      type: 'moveResult',
      seq: 2,
      outcome: 'blocked',
      player: { userId: ada, x: 0, y: 1, facing: 'down' },
    });

    await leave(walker);
  });

  it('answers a step with where the server has them, and shows it to others', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    move(walker, 'right', 7);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult'),
    ).resolves.toEqual({
      type: 'moveResult',
      seq: 7,
      outcome: 'moved',
      player: { userId: ada, x: 1, y: 0, facing: 'right' },
    });
    await expect(waitFor(watcher, (m) => m.type === 'moved')).resolves.toEqual({
      type: 'moved',
      players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
    });
    // The mover has its answer; a moved as well would draw the step twice.
    await quiet();
    expect(walker.messages.some((m) => m.type === 'moved')).toBe(false);

    await leave(walker);
    await leave(watcher);
  });

  it('keeps them on the map, and says so', async () => {
    const walker = await arrive(person());

    move(walker, 'up', 1);

    await expect(
      waitFor(walker, (m) => m.type === 'moveResult'),
    ).resolves.toMatchObject({
      seq: 1,
      outcome: 'blocked',
      player: { x: 0, y: 0, facing: 'up' },
    });

    await leave(walker);
  });

  /** A modified client that sends a flood of steps gets the walking speed and no more. */
  it('refuses steps faster than walking pace', async () => {
    const walker = await arrive(person());

    // One more than the burst allows, all at once.
    for (let seq = 0; seq <= STEP_BURST; seq++) move(walker, 'down', seq);
    await waitFor(
      walker,
      (m) => m.type === 'moveResult' && m.seq === STEP_BURST,
    );

    const results = walker.messages.filter((m) => m.type === 'moveResult');
    expect(results.map((m) => m.outcome)).toContain('too_fast');
    // Wherever they ended up, it was not every step away.
    const last = results.at(-1) as { player: { y: number } };
    expect(last.player.y).toBeLessThan(STEP_BURST + 1);

    await leave(walker);
  });

  /**
   * The point of the tick: steps are told to everybody once per tick, not
   * once per step, and only where the walker ended up.
   */
  it('tells others about several quick steps in fewer frames, ending where the walker did', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    for (let seq = 0; seq < 3; seq++) move(walker, 'right', seq);
    await waitFor(walker, (m) => m.type === 'moveResult' && m.seq === 2);
    await waitFor(watcher, (m) => m.type === 'moved');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const frames = watcher.messages.filter((m) => m.type === 'moved') as {
      players: { userId: string; x: number }[];
    }[];
    // Usually one; two if a tick happened to fall between the steps.
    expect(frames.length).toBeLessThan(3);
    const entries = frames.flatMap((frame) => frame.players);
    expect(entries.every((entry) => entry.userId === ada)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ x: 3 });

    await leave(walker);
    await leave(watcher);
  });

  it('sends nothing on a tick when nobody moved', async () => {
    const watcher = await arrive(person());

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(watcher.messages.some((m) => m.type === 'moved')).toBe(false);
    await leave(watcher);
  });

  /**
   * An update still waiting for the tick must not bring back somebody who
   * left. Can only catch that when no tick falls in the few milliseconds
   * between the step and the leave — nearly always, never guaranteed — but
   * never fails on correct code.
   */
  it('never reports a step after the walker has left', async () => {
    const ada = person();
    const walker = await arrive(ada);
    const watcher = await arrive(person());

    move(walker, 'right', 1);
    await waitFor(walker, (m) => m.type === 'moveResult');
    await leave(walker);
    await waitFor(watcher, (m) => m.type === 'left');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const leftAt = watcher.messages.findIndex((m) => m.type === 'left');
    const afterLeft = watcher.messages.slice(leftAt + 1);
    expect(afterLeft.some((m) => m.type === 'moved')).toBe(false);

    await leave(watcher);
  });

  /**
   * Walking speed limits what a flood of moves can do, not how many arrive:
   * each would still be parsed and answered. Past the message budget they
   * close the connection before parsing.
   */
  it('closes a socket that exceeds its message budget', async () => {
    const flooder = await arrive(person());

    for (let i = 0; i < 200; i++)
      flooder.ws.send(JSON.stringify({ type: 'ping' }));

    await expect(flooder.settled).resolves.toMatchObject({
      closeCode: 1008,
      closeReason: 'rate_limited',
    });
    // At most one second's budget was answered before the close.
    const pongs = flooder.messages.filter((m) => m.type === 'pong').length;
    expect(pongs).toBeGreaterThan(0);
    expect(pongs).toBeLessThanOrEqual(20);
  });

  it('rejects a direction that is not one of the four', async () => {
    const walker = await arrive(person());

    move(walker, 'northeast', 1);

    await expect(
      waitFor(walker, (m) => m.type === 'error'),
    ).resolves.toMatchObject({
      code: 'BAD_MESSAGE',
    });
    await leave(walker);
  });

  it('tells everybody when somebody leaves', async () => {
    const ada = person();
    const leaving = await arrive(ada);
    const staying = await arrive(person());

    await leave(leaving);

    await expect(waitFor(staying, (m) => m.type === 'left')).resolves.toEqual({
      type: 'left',
      userId: ada,
    });
    expect(world.gateway.players.has({ userId: ada, cohortId: COHORT })).toBe(
      false,
    );

    await leave(staying);
  });

  /** One cohort, one device, one tab: the newest connection wins. */
  /**
   * Each cohort is its own campus. Two of them may share this process and
   * the map it loaded, and still nobody in one sees or hears of anybody in
   * the other.
   */
  describe('cohorts kept apart', () => {
    const ofCohort = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages.filter((m) =>
        ['joined', 'left', 'moved'].includes(m.type as string),
      );

    it('shows an arrival only the people in the cohort they entered', async () => {
      const ada = person();
      const grace = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(grace, 'cohort-backend');

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toEqual([
        { userId: grace, x: 0, y: 0, facing: 'down' },
      ]);
      await quiet();
      expect(ofCohort(inFrontend)).toEqual([]);

      await leave(inFrontend);
      await leave(inBackend);
    });

    it('tells a move, and a departure, to nobody in another cohort', async () => {
      const ada = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const sameCohort = await arrive(person(), 'cohort-frontend');
      const otherCohort = await arrive(person(), 'cohort-backend');

      move(inFrontend, 'right', 1);
      await expect(
        waitFor(sameCohort, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      await leave(inFrontend);
      await expect(
        waitFor(sameCohort, (m) => m.type === 'left' && m.userId === ada),
      ).resolves.toBeDefined();

      await quiet();
      expect(ofCohort(otherCohort)).toEqual([]);

      await leave(sameCohort);
      await leave(otherCohort);
    });

    /**
     * Somebody standing in two cohorts at once has an avatar in each, and a
     * step in one is news only to the people in that one.
     */
    it('keeps a step in one cohort out of the other, for somebody in both', async () => {
      const ada = person();
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(ada, 'cohort-backend');

      move(inFrontend, 'right', 1);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      // Through at least one tick: Backend hears nothing of it, and its
      // avatar for them has not moved.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(backendWatcher.messages.some((m) => m.type === 'moved')).toBe(
        false,
      );
      expect(inBackend.messages.some((m) => m.type === 'moved')).toBe(false);
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-backend' }),
      ).toMatchObject({
        x: 0,
        y: 0,
      });

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });

    /** The same, for somebody who closed their socket first. */
    it('does not carry it in after leaving and coming back elsewhere', async () => {
      const ada = person();
      const backendWatcher = await arrive(person(), 'cohort-backend');
      const inFrontend = await arrive(ada, 'cohort-frontend');

      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');
      await leave(inFrontend);
      const inBackend = await arrive(ada, 'cohort-backend');

      await waitFor(backendWatcher, (m) => m.type === 'joined');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(backendWatcher.messages.some((m) => m.type === 'moved')).toBe(
        false,
      );

      await leave(inBackend);
      await leave(backendWatcher);
    });

    /**
     * Back in the same cohort inside the tick, `joined` already says where
     * they stand; the step they took before leaving is not news after it.
     */
    it('does not repeat a step as a move once they have left and come back', async () => {
      const ada = person();
      const watcher = await arrive(person(), 'cohort-frontend');
      const first = await arrive(ada, 'cohort-frontend');

      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      const second = await arrive(ada, 'cohort-frontend');

      // The second `joined` for them, one tile right of where the first was.
      const rejoined = (m: Record<string, unknown>) =>
        m.type === 'joined' && (m.player as { x: number }).x === 1;
      await expect(waitFor(watcher, rejoined)).resolves.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = watcher.messages.slice(
        watcher.messages.findIndex(rejoined),
      );
      expect(after.some((m) => m.type === 'moved')).toBe(false);

      await leave(second);
      await leave(watcher);
    });

    /** One tick may carry moves from several cohorts; each hears its own. */
    it('sorts the moves of one tick by cohort', async () => {
      const ada = person();
      const grace = person();
      const inFrontend = await arrive(ada, 'cohort-frontend');
      const inBackend = await arrive(grace, 'cohort-backend');
      const frontendWatcher = await arrive(person(), 'cohort-frontend');
      const backendWatcher = await arrive(person(), 'cohort-backend');

      move(inFrontend, 'right', 1);
      move(inBackend, 'down', 1);

      await expect(
        waitFor(frontendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: ada, x: 1, y: 0, facing: 'right' }],
      });
      await expect(
        waitFor(backendWatcher, (m) => m.type === 'moved'),
      ).resolves.toEqual({
        type: 'moved',
        players: [{ userId: grace, x: 0, y: 1, facing: 'down' }],
      });
      // Each mover has its own answer, and hears nothing of the other.
      await quiet();
      expect(inFrontend.messages.some((m) => m.type === 'moved')).toBe(false);
      expect(inBackend.messages.some((m) => m.type === 'moved')).toBe(false);

      for (const conn of [
        inFrontend,
        inBackend,
        frontendWatcher,
        backendWatcher,
      ]) {
        await leave(conn);
      }
    });
  });

  /**
   * The upgrade loads the account's saved position for the cohort it is
   * entering, and that read is the one step that waits. A second connection
   * for the same account can take its place while it does: these tests hold a
   * cohort's load open to make that race reliable.
   */
  /**
   * The upgrade loads the account's saved position for the cohort it is
   * entering, and that read is the one step that waits. Another connection
   * for the same account can arrive while it does: these tests hold a
   * cohort's load open to make that reliable.
   */
  describe('a connection that waits for its saved position', () => {
    const cookie = async (userId: string) =>
      `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`;

    /**
     * Holds every load for one cohort until `release`. A load already waiting
     * still gets the release; later loads for that cohort do not wait.
     */
    function hold(cohortId: string) {
      const gate = deferred<void>();
      store.heldLoads.set(cohortId, gate.promise);
      return {
        release: () => {
          store.heldLoads.delete(cohortId);
          gate.resolve();
        },
      };
    }

    it('replaces without an extra save when the second connection is the same cohort', async () => {
      const ada = person();
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );
      const backend = hold('cohort-backend');

      const first = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      const second = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(2);

      backend.release();

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 3,
        y: 2,
        facing: 'left',
      });
      await first.settled;
      expect(world.gateway.connections.forUser(ada)).toHaveLength(1);
      // Same-cohort replacement leaves the avatar untouched and writes
      // nothing: the store still holds only Backend's own saved position.
      expect(
        store.positions.get(
          positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        ),
      ).toEqual({
        x: 3,
        y: 2,
        facing: 'left',
      });

      await leave(second);
    });

    it('aborts a socket that closes while its load is in flight, with no avatar and no write', async () => {
      const ada = person();
      const backend = hold('cohort-backend');

      const dying = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(1);

      // The socket is paused while it waits, so a close handshake cannot
      // finish; dropping the connection is how the server learns it is gone.
      dying.ws.terminate();
      await dying.settled;
      await quiet();

      backend.release();
      await quiet();

      expect(world.gateway.connections.forUser(ada)).toEqual([]);
      expect(
        world.gateway.players.has({ userId: ada, cohortId: 'cohort-backend' }),
      ).toBe(false);
      expect(store.positions.size).toBe(0);
    });

    /** Another cohort meanwhile is another campus: nothing to wait for or undo. */
    it('enters its cohort as it would have, whatever the account did elsewhere meanwhile', async () => {
      const ada = person();
      const backend = hold('cohort-backend');
      const inBackend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      await expect.poll(() => store.loads).toBe(1);

      const inFrontend = await arrive(ada, 'cohort-frontend');
      move(inFrontend, 'right', 1);
      await waitFor(inFrontend, (m) => m.type === 'moveResult');

      backend.release();

      const snapshot = await waitFor(inBackend, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await quiet();
      expect(inFrontend.ws.readyState).toBe(WebSocket.OPEN);
      expect(world.gateway.connections.forUser(ada)).toHaveLength(2);
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
        x: 1,
        y: 0,
      });

      await leave(inFrontend);
      await leave(inBackend);
    });

    it('places both when two cohorts wait at once, each at its own saved position', async () => {
      const ada = person();
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-backend' }),
        {
          x: 3,
          y: 2,
          facing: 'left',
        },
      );
      store.positions.set(
        positionKey({ userId: ada, cohortId: 'cohort-frontend' }),
        {
          x: 4,
          y: 1,
          facing: 'right',
        },
      );
      const frontend = hold('cohort-frontend');
      const backend = hold('cohort-backend');

      const inBackend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-backend',
      );
      const inFrontend = connect(
        { origin: ORIGIN, cookie: await cookie(ada) },
        'cohort-frontend',
      );
      await expect.poll(() => store.loads).toBe(2);

      backend.release();
      frontend.release();

      await waitFor(inBackend, (m) => m.type === 'snapshot');
      await waitFor(inFrontend, (m) => m.type === 'snapshot');
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-backend' }),
      ).toMatchObject({
        x: 3,
        y: 2,
      });
      expect(
        world.gateway.players.get({ userId: ada, cohortId: 'cohort-frontend' }),
      ).toMatchObject({
        x: 4,
        y: 1,
      });

      await leave(inBackend);
      await leave(inFrontend);
    });
  });

  /**
   * Beyond the reconnect grace, where somebody stood is kept in the store
   * (Redis in production) and they start there on their next visit.
   */
  describe('between visits', () => {
    it('starts somebody where they stood last time', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 2,
        y: 3,
        facing: 'left',
      });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 2,
        y: 3,
        facing: 'left',
      });
      await leave(conn);
    });

    it('starts at the spawn when the saved tile is no longer on the map', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 9,
        y: 9,
        facing: 'up',
      });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('starts at the spawn when the saved tile is now a wall', async () => {
      const ada = person();
      store.positions.set(positionKey({ userId: ada }), {
        ...WALL,
        facing: 'up',
      });

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('starts at the spawn when the store cannot answer', async () => {
      const ada = person();
      store.failLoad = true;

      const conn = await arrive(ada);

      const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 0,
        y: 0,
        facing: 'down',
      });
      await leave(conn);
    });

    it('saves where they stood when their last tab closes', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'right', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await leave(conn);

      await expect
        .poll(() => store.positions.get(positionKey({ userId: ada })))
        .toEqual({ x: 1, y: 0, facing: 'right' });
    });

    it('saves somebody who moved while they are still here', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'down', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');

      await expect
        .poll(() => store.positions.get(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
        .toEqual({ x: 0, y: 1, facing: 'down' });
      await leave(conn);
    });

    /** The grace in memory is fresher than the store, and costs no round trip. */
    it('does not ask the store when reconnecting within the grace', async () => {
      const ada = person();
      const first = await arrive(ada);
      move(first, 'right', 1);
      await waitFor(first, (m) => m.type === 'moveResult');
      await leave(first);
      await expect
        .poll(() =>
          world.gateway.players.isRemembered({ userId: ada, cohortId: COHORT }),
        )
        .toBe(true);
      const loadsBefore = store.loads;

      const again = await arrive(ada);

      expect(store.loads).toBe(loadsBefore);
      const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
      expect(positionsIn(snapshot)).toContainEqual({
        userId: ada,
        x: 1,
        y: 0,
        facing: 'right',
      });
      await leave(again);
    });

    it('forgets the saved position when access is taken away', async () => {
      const ada = person();
      const conn = await arrive(ada);
      move(conn, 'right', 1);
      await waitFor(conn, (m) => m.type === 'moveResult');
      await expect
        .poll(() => store.positions.has(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
        .toBe(true);

      accounts.suspended.add(ada);

      await expect(conn.settled).resolves.toMatchObject({ closeCode: 1008 });
      await expect
        .poll(() => store.positions.has(positionKey({ userId: ada })), {
          timeout: 3_000,
        })
        .toBe(false);
    }, 15_000);
  });

  describe('where everybody is', () => {
    const spaceChanges = (conn: { messages: Record<string, unknown>[] }) =>
      conn.messages
        .filter((m) => m.type === 'spaceChanged')
        .map(({ userId, spaceKey }) => ({ userId, spaceKey }));

    it('shows the space of everybody in the snapshot and in joined', async () => {
      const ada = person();
      const grace = person();
      store.positions.set(positionKey({ userId: ada }), {
        x: 3,
        y: 1,
        facing: 'left',
      });
      const first = await arrive(ada);
      const second = await arrive(grace);

      const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
      expect(snapshot.players).toContainEqual(
        expect.objectContaining({ userId: ada, spaceKey: 'library' }),
      );
      await expect(
        waitFor(
          first,
          (m) =>
            m.type === 'joined' &&
            (m.player as { userId: string }).userId === grace,
        ),
      ).resolves.toMatchObject({ player: { spaceKey: DEFAULT_SPACE_KEY } });
      await Promise.all([leave(first), leave(second)]);
    });

    it('tells the cohort, the walker included, when somebody steps into another space and out again', async () => {
      const ada = person();
      const walker = await arrive(ada);
      const watcher = await arrive(person());
      const elsewhere = await arrive(person(), 'cohort-frontend');

      for (const seq of [1, 2, 3]) await step(walker, 'right', seq);
      await step(walker, 'down', 4);
      await step(walker, 'left', 5);
      await quiet();

      const expected = [
        { userId: ada, spaceKey: 'library' },
        { userId: ada, spaceKey: DEFAULT_SPACE_KEY },
      ];
      expect(spaceChanges(walker)).toEqual(expected);
      expect(spaceChanges(watcher)).toEqual(expected);
      expect(spaceChanges(elsewhere)).toEqual([]);
      await Promise.all([leave(walker), leave(watcher), leave(elsewhere)]);
    });
  });
});
