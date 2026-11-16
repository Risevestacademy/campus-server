import { DEFAULT_SPACE_KEY, SessionScope } from '@campus/session';
import { describe, expect, it, vi } from 'vitest';

import type { WorldMap } from '../movement/world-map.js';
import { spaceAt, spaceIndexFrom } from '../movement/spaces.js';
import { tileIndex, walkable } from '../movement/grid.js';
import { COHORT, ORIGIN, SECRET } from './gateway.testing.js';
import {
  accounts,
  arrive,
  connect,
  deferred,
  leave,
  map,
  mapSource,
  move,
  person,
  presence,
  quiet,
  step,
  token,
  url,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

/** A 5 × 5 campus with the same old wall at (0, 2), unless overridden. */
function nextMap(
  version: string,
  options: {
    walls?: { x: number; y: number }[];
    library?: { x: number; y: number; width: number; height: number };
  } = {},
): WorldMap {
  const walls = new Uint8Array(5 * 5);
  walls[tileIndex({ width: 5 }, { x: 0, y: 2 })] = 1;
  for (const wall of options.walls ?? []) {
    walls[tileIndex({ width: 5 }, wall)] = 1;
  }
  return {
    id: 'campus',
    version,
    grid: { width: 5, height: 5, spawn: { x: 0, y: 0 }, walls },
    spaces: spaceIndexFrom({
      widthTiles: 5,
      heightTiles: 5,
      collisions: [],
      spawn: { x: 0, y: 0 },
      spaces: options.library
        ? [
            {
              key: 'library',
              name: 'Library',
              kind: null,
              bounds: { shape: 'rect', ...options.library },
              properties: {},
            },
          ]
        : [],
      portals: [],
      desks: [],
    }),
  };
}

const publish = (next: WorldMap, key = 'campus') => {
  accounts.publishedKey = key;
  mapSource.next = next;
  accounts.notifySpaces(key);
};

const waitForMap = (version: string) =>
  vi.waitFor(() => expect(map.version).toBe(version));

const messagesOf = (
  conn: { messages: Record<string, unknown>[] },
  type: string,
) => conn.messages.filter((message) => message.type === type);

/** The phone's way in: the avatar only if nobody holds it, else a watcher. */
async function watching(userId: string) {
  const conn = connect(
    {
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
    },
    '',
    `${url}?cohortId=${encodeURIComponent(COHORT)}&enter=ifFree`,
  );
  await waitFor(conn, (message) => message.type === 'snapshot');
  return conn;
}

describe('publishing a map', () => {
  it('swaps in the new walls and space index without a restart', async () => {
    const conn = await arrive(person());
    const next = nextMap('v2', {
      walls: [{ x: 1, y: 0 }],
      library: { x: 2, y: 0, width: 3, height: 2 },
    });

    expect(walkable(map.grid, { x: 1, y: 0 })).toBe(true);
    expect(spaceAt(map.spaces, { x: 2, y: 0 })).toBe(DEFAULT_SPACE_KEY);

    publish(next);
    await waitForMap('v2');

    expect(map.grid).toBe(next.grid);
    expect(map.spaces).toBe(next.spaces);
    expect(walkable(map.grid, { x: 1, y: 0 })).toBe(false);
    expect(spaceAt(map.spaces, { x: 2, y: 0 })).toBe('library');
    await expect(step(conn, 'right', 1)).resolves.toMatchObject({
      outcome: 'blocked',
    });
    await leave(conn);
  });

  it('nudges a player whose tile became a wall to the nearest walkable tile', async () => {
    const userId = person();
    const conn = await arrive(userId);
    await step(conn, 'right', 1);
    await step(conn, 'right', 2);
    expect(
      world.gateway.players.get({ userId, cohortId: COHORT }),
    ).toMatchObject({ x: 2, y: 0 });

    publish(nextMap('v2', { walls: [{ x: 2, y: 0 }] }));

    const corrected = await waitFor(conn, (message) => {
      return message.type === 'positionCorrected';
    });
    expect(corrected.player).toEqual({
      userId,
      x: 2,
      y: 1,
      facing: 'right',
    });
    expect(
      world.gateway.players.get({ userId, cohortId: COHORT }),
    ).toMatchObject({ x: 2, y: 1 });
    const types = conn.messages.map((message) => message.type);
    expect(types.indexOf('mapChanged')).toBeLessThan(
      types.indexOf('positionCorrected'),
    );
    await leave(conn);
  });

  it('crosses a player into the space a changed boundary puts them in', async () => {
    const userId = person();
    const conn = await arrive(userId);
    await step(conn, 'right', 1);
    await step(conn, 'right', 2);
    presence.crossings.length = 0;

    publish(
      nextMap('v2', {
        library: { x: 2, y: 0, width: 3, height: 2 },
      }),
    );

    await waitForMap('v2');
    await waitFor(conn, (message) => {
      return message.type === 'spaceChanged' && message.userId === userId;
    });
    expect(
      world.gateway.players.get({ userId, cohortId: COHORT }),
    ).toMatchObject({ x: 2, y: 0 });
    expect(presence.crossings.at(-1)).toMatchObject({
      userId,
      spaceKey: 'library',
    });
    const last = conn.messages
      .filter((message) => message.type === 'spaceChanged')
      .at(-1);
    expect(last).toMatchObject({ spaceKey: 'library' });
    const types = conn.messages.map((message) => message.type);
    expect(types.indexOf('mapChanged')).toBeLessThan(
      types.lastIndexOf('spaceChanged'),
    );
    await leave(conn);
  });

  it('leaves a player whose tile and space did not change alone', async () => {
    const userId = person();
    const conn = await arrive(userId);
    world.gateway.players.place({ userId, cohortId: COHORT }, { x: 4, y: 4 });

    publish(nextMap('v2', { walls: [{ x: 0, y: 4 }] }));
    await waitForMap('v2');
    await quiet();

    expect(messagesOf(conn, 'positionCorrected')).toEqual([]);
    expect(
      messagesOf(conn, 'spaceChanged').filter(
        (message) => message.userId === userId,
      ),
    ).toEqual([]);
    await leave(conn);
  });

  it('broadcasts the map to everybody, and a later arrival gets it in its snapshot', async () => {
    const ada = await arrive(person());
    const linus = await arrive(person());

    publish(nextMap('v2'));
    await waitForMap('v2');

    for (const conn of [ada, linus]) {
      await expect(
        waitFor(conn, (message) => message.type === 'mapChanged'),
      ).resolves.toMatchObject({
        map: { id: 'campus', version: 'v2', width: 5, height: 5 },
      });
    }

    const late = await arrive(person());
    const snapshot = late.messages.find(
      (message) => message.type === 'snapshot',
    );
    expect(snapshot).toMatchObject({
      map: { id: 'campus', version: 'v2', width: 5, height: 5 },
    });
    await Promise.all([leave(ada), leave(linus), leave(late)]);
  });

  it('sends mapChanged to a watcher', async () => {
    const adaId = person();
    const ada = await arrive(adaId);
    const phone = await watching(adaId);
    try {
      expect(
        (await waitFor(phone, (message) => message.type === 'welcome')).mode,
      ).toBe('watcher');

      publish(nextMap('v2'));

      await expect(
        waitFor(phone, (message) => message.type === 'mapChanged'),
      ).resolves.toMatchObject({
        map: { id: 'campus', version: 'v2', width: 5, height: 5 },
      });
    } finally {
      await leave(phone);
      await leave(ada);
    }
  });

  it('sends a watcher no correction frames for its avatar', async () => {
    const adaId = person();
    const ada = await arrive(adaId);
    const phone = await watching(adaId);
    try {
      await step(ada, 'right', 1);
      await step(ada, 'right', 2);

      publish(nextMap('v2', { walls: [{ x: 2, y: 0 }] }));
      await waitForMap('v2');
      await quiet();

      expect(messagesOf(phone, 'positionCorrected')).toEqual([]);
      expect(messagesOf(phone, 'moved')).toEqual([]);
    } finally {
      await leave(phone);
      await leave(ada);
    }
  });

  it('processes a move that arrives during the read, then corrects it against the new map', async () => {
    const userId = person();
    const conn = await arrive(userId);
    const hold = deferred<void>();
    mapSource.hold = hold.promise;
    mapSource.next = nextMap('v2', { walls: [{ x: 1, y: 0 }] });
    accounts.publishedKey = 'campus';
    accounts.notifySpaces('campus');

    move(conn, 'right', 1);
    await expect(
      waitFor(conn, (message) => {
        return message.type === 'moveResult' && message.seq === 1;
      }),
    ).resolves.toMatchObject({ outcome: 'moved' });

    hold.resolve();
    await waitForMap('v2');
    await expect(
      waitFor(conn, (message) => message.type === 'positionCorrected'),
    ).resolves.toMatchObject({
      player: { userId, x: 1, y: 1 },
    });
    await leave(conn);
  });

  it('keeps the old map when the read fails, and takes a later good publish', async () => {
    const userId = person();
    const conn = await arrive(userId);
    const before = world.gateway.players.get({ userId, cohortId: COHORT });

    mapSource.fail = true;
    publish(nextMap('v2'));
    await quiet();
    expect(map.version).toBe('v-test');
    expect(world.gateway.players.get({ userId, cohortId: COHORT })).toEqual(
      before,
    );

    mapSource.fail = false;
    publish(nextMap('v3'));
    await waitForMap('v3');
    await leave(conn);
  });

  it('keeps the old map when the new one is malformed', async () => {
    const userId = person();
    const conn = await arrive(userId);
    const before = world.gateway.players.get({ userId, cohortId: COHORT });
    const malformed = nextMap('v2');
    malformed.grid.walls![tileIndex({ width: 5 }, { x: 0, y: 0 })] = 1;

    publish(malformed);
    await quiet();

    expect(map.version).toBe('v-test');
    expect(world.gateway.players.get({ userId, cohortId: COHORT })).toEqual(
      before,
    );
    await leave(conn);
  });

  it('serves the latest of two quick notifications', async () => {
    const conn = await arrive(person());
    const hold = deferred<void>();
    mapSource.hold = hold.promise;
    accounts.publishedKey = 'campus';

    mapSource.next = nextMap('v2');
    accounts.notifySpaces('campus');
    mapSource.next = nextMap('v3');
    accounts.notifySpaces('campus');

    hold.resolve();
    await waitForMap('v3');
    expect(mapSource.loads).toBeGreaterThanOrEqual(2);
    await leave(conn);
  });

  it('ignores a key world does not serve', async () => {
    const conn = await arrive(person());

    accounts.publishedKey = 'campus';
    accounts.notifySpaces('other');
    accounts.notifySpaces('not a map key');
    await quiet();

    expect(map.version).toBe('v-test');
    expect(mapSource.loads).toBe(0);
    await leave(conn);
  });

  it('fixes up everybody together: a wall, an unchanged tile and a boundary change', async () => {
    const wallUserId = person();
    const stillUserId = person();
    const crossingUserId = person();
    const wall = await arrive(wallUserId);
    const still = await arrive(stillUserId);
    const crossing = await arrive(crossingUserId);
    world.gateway.players.place(
      { userId: wallUserId, cohortId: COHORT },
      {
        x: 2,
        y: 0,
      },
    );
    world.gateway.players.place(
      { userId: stillUserId, cohortId: COHORT },
      {
        x: 4,
        y: 3,
      },
    );
    world.gateway.players.place(
      { userId: crossingUserId, cohortId: COHORT },
      { x: 0, y: 0 },
    );
    presence.crossings.length = 0;

    publish(
      nextMap('v2', {
        walls: [{ x: 2, y: 0 }],
        library: { x: 0, y: 0, width: 2, height: 2 },
      }),
    );
    await waitForMap('v2');

    await expect(
      waitFor(wall, (message) => message.type === 'positionCorrected'),
    ).resolves.toMatchObject({
      player: { userId: wallUserId, x: 2, y: 1 },
    });
    await expect(
      waitFor(crossing, (message) => {
        return (
          message.type === 'spaceChanged' && message.userId === crossingUserId
        );
      }),
    ).resolves.toMatchObject({ spaceKey: 'library' });
    expect(messagesOf(still, 'positionCorrected')).toEqual([]);
    expect(
      messagesOf(still, 'spaceChanged').filter(
        (message) => message.userId === stillUserId,
      ),
    ).toEqual([]);
    // One build, however many players had to be checked.
    expect(mapSource.loads).toBe(1);
    await Promise.all([leave(wall), leave(still), leave(crossing)]);
  });
});
