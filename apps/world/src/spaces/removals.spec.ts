import { DEFAULT_SPACE_KEY } from '@campus/session';
import { describe, expect, it } from 'vitest';

import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import { REMOVED_FOR_MS, SpaceRemovals, nearestOutside } from './removals.js';

const ada = { userId: 'ada', cohortId: 'cohort-1' };

describe('SpaceRemovals', () => {
  it('keeps somebody out of one space for 90 seconds, and no longer', () => {
    const removals = new SpaceRemovals();

    expect(removals.remove(ada, 'library', 1_000)).toBe(1_000 + REMOVED_FOR_MS);
    expect(removals.isRemoved(ada, 'library', 1_000 + REMOVED_FOR_MS - 1)).toBe(
      true,
    );
    expect(removals.isRemoved(ada, 'library', 1_000 + REMOVED_FOR_MS)).toBe(
      false,
    );
  });

  it('keeps them out of that space alone, in that cohort alone', () => {
    const removals = new SpaceRemovals();
    removals.remove(ada, 'library', 0);

    expect(removals.isRemoved(ada, 'lab', 0)).toBe(false);
    expect(
      removals.isRemoved({ ...ada, cohortId: 'cohort-2' }, 'library', 0),
    ).toBe(false);
  });

  it('forgets removals that have run out whenever another is made', () => {
    const removals = new SpaceRemovals();
    removals.remove(ada, 'library', 0);
    removals.remove({ ...ada, userId: 'grace' }, 'lab', 1);

    removals.remove({ ...ada, userId: 'linus' }, 'library', REMOVED_FOR_MS);

    expect(removals.size).toBe(2);
  });
});

describe('nearestOutside', () => {
  // 6 × 1, a wall at x 5: the library at x 2 to 3, the lab at x 0 to 1,
  // the corridor at x 4.
  const walls = new Uint8Array(6);
  walls[tileIndex({ width: 6 }, { x: 5, y: 0 })] = 1;
  const grid = { width: 6, height: 1, spawn: { x: 4, y: 0 }, walls };
  const spaces = spaceIndexFrom({
    widthTiles: 6,
    heightTiles: 1,
    collisions: [],
    spawn: { x: 4, y: 0 },
    spaces: [
      {
        key: 'lab',
        name: 'Lab',
        kind: null,
        bounds: { shape: 'rect', x: 0, y: 0, width: 2, height: 1 },
        properties: {},
      },
      {
        key: 'library',
        name: 'Library',
        kind: null,
        bounds: { shape: 'rect', x: 2, y: 0, width: 2, height: 1 },
        properties: {},
      },
    ],
    portals: [],
    desks: [],
  });

  it('finds the nearest floor outside, in a space they may stand in', () => {
    expect(
      nearestOutside(grid, spaces, { x: 2, y: 0 }, 'library', () => true),
    ).toEqual({ x: 1, y: 0 });
  });

  it('passes over a space they may not stand in', () => {
    expect(
      nearestOutside(
        grid,
        spaces,
        { x: 2, y: 0 },
        'library',
        (spaceKey) => spaceKey === DEFAULT_SPACE_KEY,
      ),
    ).toEqual({ x: 4, y: 0 });
  });

  it('finds nothing when nowhere outside will do', () => {
    expect(
      nearestOutside(grid, spaces, { x: 2, y: 0 }, 'library', () => false),
    ).toBeUndefined();
  });
});
