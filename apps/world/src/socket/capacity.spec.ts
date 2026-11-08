import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  accounts,
  arrive,
  leave,
  openLibrary,
  person,
  positionKey,
  positionsIn,
  step,
  store,
  toTheDoor,
  useWorld,
  waitFor,
  walkToLibrary,
  world,
} from './gateway.testing.js';

useWorld();

/**
 * The library (x 3 to 4, y 0 to 1) with a capacity: a step into it is
 * answered `full` once it holds that many people.
 */
describe('space capacity', () => {
  const send = (conn: { ws: WebSocket }, message: Record<string, unknown>) =>
    conn.ws.send(JSON.stringify(message));

  async function libraryHolding(capacity: number | null): Promise<void> {
    openLibrary(capacity);
    await world.gateway.spacesChanged();
  }

  it('refuses a step into a space at capacity', async () => {
    await libraryHolding(2);
    const first = await arrive(person());
    const second = await arrive(person());
    const third = await arrive(person());

    await expect(walkToLibrary(first)).resolves.toMatchObject({
      outcome: 'moved',
    });
    await expect(walkToLibrary(second)).resolves.toMatchObject({
      outcome: 'moved',
    });
    await expect(walkToLibrary(third)).resolves.toMatchObject({
      outcome: 'full',
      player: { x: 2, y: 0, facing: 'right' },
    });
    await Promise.all([leave(first), leave(second), leave(third)]);
  });

  it('lets somebody in once a person leaves a full space', async () => {
    await libraryHolding(1);
    const first = await arrive(person());
    const second = await arrive(person());

    await walkToLibrary(first);
    await expect(walkToLibrary(second)).resolves.toMatchObject({
      outcome: 'full',
    });

    // First steps down out of the library, to (3, 2).
    await step(first, 'down', 4);
    await step(first, 'down', 5);
    await expect(step(second, 'right', 4)).resolves.toMatchObject({
      outcome: 'moved',
    });
    await Promise.all([leave(first), leave(second)]);
  });

  it('has no limit when capacity is null', async () => {
    await libraryHolding(null);
    const people = await Promise.all([1, 2, 3].map(() => arrive(person())));

    for (const conn of people) {
      await expect(walkToLibrary(conn)).resolves.toMatchObject({
        outcome: 'moved',
      });
    }
    await Promise.all(people.map(leave));
  });

  it('holds an admin to it too', async () => {
    await libraryHolding(1);
    const admin = person();
    accounts.admins.add(admin);
    const regular = await arrive(person());
    const adminConn = await arrive(admin);

    await walkToLibrary(regular);
    await expect(walkToLibrary(adminConn)).resolves.toMatchObject({
      outcome: 'full',
    });
    await Promise.all([leave(regular), leave(adminConn)]);
  });

  it('says refused, not full, for a space both locked and full', async () => {
    await libraryHolding(1);
    const inside = await arrive(person());
    const outside = await arrive(person());

    await walkToLibrary(inside);
    send(inside, { type: 'setLock', locked: true });
    await waitFor(inside, (m) => m.type === 'lockChanged');

    await expect(walkToLibrary(outside)).resolves.toMatchObject({
      outcome: 'refused',
    });
    await Promise.all([leave(inside), leave(outside)]);
  });

  it('holds somebody let in by a yes to it too', async () => {
    await libraryHolding(1);
    const insider = await arrive(person());
    const asker = person();
    const outside = await arrive(asker);

    await walkToLibrary(insider);
    send(insider, { type: 'setLock', locked: true });
    await waitFor(insider, (m) => m.type === 'lockChanged');
    await toTheDoor(outside);
    send(outside, { type: 'requestEntry', spaceKey: 'library' });
    const asked = await waitFor(
      insider,
      (m) => m.type === 'entryRequested' && m.userId === asker,
    );
    send(insider, {
      type: 'answerEntryRequest',
      requestId: asked.requestId,
      admit: true,
    });
    await expect(
      waitFor(outside, (m) => m.type === 'entryRequestEnded'),
    ).resolves.toMatchObject({ outcome: 'admitted' });

    await expect(step(outside, 'right', 3)).resolves.toMatchObject({
      outcome: 'full',
    });
    await Promise.all([leave(insider), leave(outside)]);
  });

  it('ends a walk to somebody in a full space with full', async () => {
    await libraryHolding(2);
    const target = person();
    const targetConn = await arrive(target);
    const insider = await arrive(person());
    const walker = await arrive(person());

    await walkToLibrary(targetConn);
    // The insider is the one who fills it.
    await expect(walkToLibrary(insider)).resolves.toMatchObject({
      outcome: 'moved',
    });

    send(walker, { type: 'goTo', userId: target });
    await expect(
      waitFor(walker, (m) => m.type === 'walkEnded'),
    ).resolves.toMatchObject({
      reason: 'full',
      spaceKey: 'library',
      mayAsk: false,
    });
    await Promise.all([leave(targetConn), leave(insider), leave(walker)]);
  });

  it('starts somebody at the spawn when their saved space has filled', async () => {
    await libraryHolding(1);
    const inside = await arrive(person());
    await walkToLibrary(inside);
    const ada = person();
    store.positions.set(positionKey({ userId: ada }), {
      x: 4,
      y: 1,
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
    await Promise.all([leave(inside), leave(conn)]);
  });

  it('puts somebody back in their saved space when it has room', async () => {
    await libraryHolding(1);
    const ada = person();
    store.positions.set(positionKey({ userId: ada }), {
      x: 4,
      y: 1,
      facing: 'up',
    });

    const conn = await arrive(ada);

    const snapshot = await waitFor(conn, (m) => m.type === 'snapshot');
    expect(positionsIn(snapshot)).toContainEqual({
      userId: ada,
      x: 4,
      y: 1,
      facing: 'up',
    });
    await leave(conn);
  });

  it('keeps somebody in a full space when they open a second socket', async () => {
    await libraryHolding(1);
    const ada = person();
    const first = await arrive(ada);
    await walkToLibrary(first);

    const second = await arrive(ada);

    const snapshot = await waitFor(second, (m) => m.type === 'snapshot');
    expect(positionsIn(snapshot)).toContainEqual(
      expect.objectContaining({ userId: ada, x: 3, y: 0 }),
    );
    await Promise.all([leave(first), leave(second)]);
  });
});
