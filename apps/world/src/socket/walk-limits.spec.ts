import { DEFAULT_SPACE_KEY } from '@campus/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Direction,
  step,
  tileIndex,
  walkable,
  type Grid,
  type Tile,
} from '../movement/grid.js';
import type { MoveOutcome, Player } from '../movement/players.js';
import { emptySpaceIndex, spaceIndexFrom } from '../movement/spaces.js';
import type { WorldMap } from '../movement/world-map.js';
import type { Connection } from './connections.js';
import { createWalks } from './features/walks.js';

/*
 * The walk's own rules, driven step by step on fake timers: what ends a walk
 * after failed steps, and where its step limit lies. Over real sockets these
 * depend on how a lock or a chase lines up with the walk's timer; here each
 * step happens exactly when the clock says.
 */

const STEP_MS = 100;
const COHORT = 'cohort-1';

interface Harness {
  walker: Connection;
  /** What the walker's socket was sent. */
  sent: Record<string, unknown>[];
  goTo(): void;
  goToTile(tile: Tile): void;
  replanAll(): void;
  /** Lets every timer the walk sets run, and the promises they start. */
  settle(): Promise<void>;
  /** Steps the walker took. */
  walked(): Player[];
  ended(): Record<string, unknown> | undefined;
}

/**
 * One walker and one person to walk to, on `map`. `outcomes` replaces what
 * the walker's next steps come to, one per step, before the step is tried:
 * `null` lets that step be taken as usual. `onForced` runs as each of those
 * is given, with how many so far. `afterStep` runs after each step the
 * walker actually takes, so the other person can move in answer.
 */
function harness(
  map: WorldMap,
  walkerAt: Tile,
  personAt: Tile,
  {
    outcomes = [],
    mayStepInto = () => true,
    onForced,
    afterStep,
  }: {
    outcomes?: (Exclude<MoveOutcome, 'moved'> | null)[];
    mayStepInto?: (spaceKey: string) => boolean;
    onForced?: (count: number) => void;
    afterStep?: (from: Player, to: Player, person: Player) => void;
  } = {},
): Harness {
  const connection = (userId: string) =>
    ({
      userId,
      cohortId: COHORT,
      spaceKey: DEFAULT_SPACE_KEY,
      socket: { userId },
    }) as unknown as Connection;
  const walker = connection('walker');
  const person = connection('person');
  const standing = new Map<Connection, Player>([
    [walker, { userId: 'walker', ...walkerAt, facing: Direction.Down }],
    [person, { userId: 'person', ...personAt, facing: Direction.Down }],
  ]);
  const sent: Record<string, unknown>[] = [];
  const queued = [...outcomes];
  let forcedSoFar = 0;

  const walks = createWalks(
    {
      app: { log: { warn: vi.fn() } } as never,
      env: { WORLD_STEP_MS: STEP_MS } as never,
      map,
      connections: {
        has: (c: Connection) => standing.has(c),
        holderOf: ({ userId }: { userId: string }) =>
          userId === 'person' ? person : undefined,
      } as never,
      players: {
        get: (c: Connection) => {
          const player = standing.get(c);
          return player && { ...player };
        },
        in: () => [...standing.values()],
        move: (
          c: Connection,
          direction: Direction,
          _now: number,
          admits: (tile: Tile) => true | 'refused' | 'full',
        ) => {
          const me = standing.get(c) as Player;
          const forced = queued.shift();
          if (forced) {
            onForced?.(++forcedSoFar);
            return { outcome: forced, player: { ...me }, changed: false };
          }
          const to = step(me, direction);
          if (!walkable(map.grid, to)) {
            return { outcome: 'blocked', player: { ...me }, changed: false };
          }
          const admission = admits(to);
          if (admission !== true) {
            return { outcome: admission, player: { ...me }, changed: false };
          }
          const from = { ...me };
          me.x = to.x;
          me.y = to.y;
          afterStep?.(from, { ...me }, standing.get(person) as Player);
          return { outcome: 'moved', player: { ...me }, changed: true };
        },
      } as never,
      send: (socket: unknown, message: unknown) => {
        if (socket === walker.socket) {
          sent.push(message as Record<string, unknown>);
        }
      },
      isStopping: () => false,
    },
    {
      presence: { online: async () => [], instanceId: 'here' },
      readRoomLinkPasses: async () => {},
      requests: {
        hasPass: () => false,
        passFor: () => null,
        mayAsk: () => true,
      } as never,
      mayStepInto: (_c, spaceKey) => mayStepInto(spaceKey),
      isFull: () => false,
      noteMoved: () => {},
      arrivedAt: () => {},
      analytics: { walkEnded: () => {} },
      noteRefusal: () => {},
    },
  );

  return {
    walker,
    sent,
    goTo: () => walks.goTo(walker, 'person'),
    goToTile: (tile) => walks.goToTile(walker, tile),
    replanAll: () => walks.replanAll(),
    settle: () => vi.runAllTimersAsync().then(() => undefined),
    walked: () =>
      sent.filter((m) => m.type === 'walking').map((m) => m.player as Player),
    ended: () => sent.find((m) => m.type === 'walkEnded'),
  };
}

/** An open floor, the edge its only wall. */
const openMap = (width: number, height: number): WorldMap => ({
  id: 'test',
  version: '1',
  grid: { width, height, spawn: { x: 0, y: 0 } },
  spaces: emptySpaceIndex(width, height),
});

/** Walls on these tiles. */
function walled(width: number, height: number, walls: Tile[]): Grid {
  const grid = new Uint8Array(width * height);
  for (const wall of walls) grid[tileIndex({ width }, wall)] = 1;
  return { width, height, spawn: { x: 0, y: 0 }, walls: grid };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('failed steps', () => {
  it('ends with no_way where they stood after two failed steps in a row', async () => {
    const h = harness(
      openMap(5, 1),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      {
        outcomes: ['blocked', 'blocked'],
      },
    );

    h.goTo();
    await h.settle();

    expect(h.walked()).toEqual([]);
    expect(h.ended()).toMatchObject({
      reason: 'no_way',
      player: { x: 0, y: 0 },
    });
  });

  it('carries on after one failed step, and after failures a step apart', async () => {
    const h = harness(
      openMap(5, 1),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      {
        outcomes: ['blocked', null, 'blocked', null, 'refused'],
      },
    );

    h.goTo();
    await h.settle();

    expect(h.walked().map((p) => p.x)).toEqual([1, 2, 3]);
    expect(h.ended()).toMatchObject({ reason: 'arrived', player: { x: 3 } });
  });

  /** A room over x 2 to 4 of a 5 × 1 floor: its door is from x 1 to x 2. */
  const roomMap = (): WorldMap => ({
    ...openMap(5, 1),
    spaces: spaceIndexFrom({
      widthTiles: 5,
      heightTiles: 1,
      collisions: [],
      spawn: { x: 0, y: 0 },
      spaces: [
        {
          key: 'room',
          name: 'room',
          kind: null,
          bounds: { shape: 'rect', x: 2, y: 0, width: 3, height: 1 },
          properties: {},
        },
      ],
      portals: [],
      desks: [],
    }),
  });

  it('stops beside the door after two refused steps in a row when it has since closed', async () => {
    // The door refuses twice while the room still looks open to the walk,
    // as when a list changes between a check and a step; by the second
    // refusal it is closed to them.
    let open = true;
    const h = harness(
      roomMap(),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      {
        outcomes: [null, 'refused', 'refused'],
        onForced: (count) => {
          if (count === 2) open = false;
        },
        mayStepInto: (spaceKey) => spaceKey !== 'room' || open,
      },
    );

    h.goTo();
    // A step at 0, refusals at one and two steps: it ends on the second, not
    // a step later.
    await vi.advanceTimersByTimeAsync(2 * STEP_MS);

    expect(h.walked().map((p) => p.x)).toEqual([1]);
    expect(h.ended()).toMatchObject({
      reason: 'refused',
      spaceKey: 'room',
      mayAsk: true,
      player: { x: 1, y: 0 },
    });
  });

  it('reads the passes again and goes on after two refused steps when the door is open after all', async () => {
    const h = harness(
      roomMap(),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      {
        outcomes: [null, 'refused', 'refused'],
      },
    );

    h.goTo();
    await h.settle();

    expect(h.walked().map((p) => p.x)).toEqual([1, 2, 3]);
    expect(h.ended()).toMatchObject({ reason: 'arrived', player: { x: 3 } });
  });

  it('does not count a step refused for speed as a failure', async () => {
    const h = harness(
      openMap(5, 1),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      {
        outcomes: ['too_fast', 'too_fast', 'too_fast', 'blocked'],
      },
    );

    h.goTo();
    await h.settle();

    expect(h.ended()).toMatchObject({ reason: 'arrived', player: { x: 3 } });
  });
});

describe('the step limit', () => {
  /**
   * A 3 × 3 floor with a wall in the middle: a ring of eight tiles. The
   * person stands across it and takes a step around it, the same way, after
   * every step the walker takes, so the walker never gains on them.
   */
  const RING: Tile[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 1, y: 2 },
    { x: 0, y: 2 },
    { x: 0, y: 1 },
  ];
  const onRing = (tile: Tile) =>
    RING.findIndex((t) => t.x === tile.x && t.y === tile.y);

  const runsAway = (from: Player, to: Player, person: Player) => {
    const turn = (onRing(to) - onRing(from) + RING.length) % RING.length;
    const next = RING[(onRing(person) + turn) % RING.length] as Tile;
    person.x = next.x;
    person.y = next.y;
  };

  const ringMap = (): WorldMap => ({
    id: 'ring',
    version: '1',
    grid: walled(3, 3, [{ x: 1, y: 1 }]),
    spaces: emptySpaceIndex(3, 3),
  });

  it("ends a chase with no_way after the map's width × height steps", async () => {
    const h = harness(
      ringMap(),
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      {
        afterStep: runsAway,
      },
    );

    h.goTo();
    await h.settle();

    expect(h.walked()).toHaveLength(3 * 3);
    expect(h.ended()).toMatchObject({ reason: 'no_way' });
  });

  it('takes its limit from the map as it is after a reload', async () => {
    const map = ringMap();
    const h = harness(
      map,
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      {
        afterStep: runsAway,
      },
    );

    h.goTo();
    await vi.advanceTimersByTimeAsync(0);
    // The same ring, on a map one row taller: a row of wall below it.
    map.grid = walled(3, 4, [
      { x: 1, y: 1 },
      { x: 0, y: 3 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
    ]);
    map.spaces = emptySpaceIndex(3, 4);
    h.replanAll();
    await h.settle();

    expect(h.walked()).toHaveLength(3 * 4);
    expect(h.ended()).toMatchObject({ reason: 'no_way' });
  });

  it('is never reached by a walk that can arrive', async () => {
    // The longest shortest path on a 5 × 5 floor, corner to corner.
    const h = harness(openMap(5, 5), { x: 0, y: 0 }, { x: 0, y: 0 });

    h.goToTile({ x: 4, y: 4 });
    await h.settle();

    expect(h.walked()).toHaveLength(8);
    expect(h.ended()).toMatchObject({
      reason: 'arrived',
      player: { x: 4, y: 4 },
    });
  });
});
