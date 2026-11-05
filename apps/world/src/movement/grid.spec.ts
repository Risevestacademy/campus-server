import { describe, expect, it } from 'vitest';

import { nearestWalkable, tileIndex } from './grid.js';

describe('nearestWalkable', () => {
  const walls = new Uint8Array(5 * 3);
  walls[tileIndex({ width: 5 }, { x: 2, y: 0 })] = 1;

  it('finds the nearest floor, in Direction order when two are equally near', () => {
    // The tile itself is a wall. Up is off the map; down is the first
    // walkable neighbour in up, down, left, right order.
    expect(
      nearestWalkable(
        { width: 5, height: 3, spawn: { x: 0, y: 0 }, walls },
        { x: 2, y: 0 },
      ),
    ).toEqual({ x: 2, y: 1 });
  });

  it('leaves a walkable tile where it is', () => {
    expect(
      nearestWalkable(
        { width: 5, height: 3, spawn: { x: 0, y: 0 }, walls },
        { x: 1, y: 0 },
      ),
    ).toEqual({ x: 1, y: 0 });
  });

  it('finds nothing when there is no floor at all', () => {
    const allWall = new Uint8Array(2 * 2).fill(1);

    expect(
      nearestWalkable(
        { width: 2, height: 2, spawn: { x: 0, y: 0 }, walls: allWall },
        { x: 0, y: 0 },
      ),
    ).toBeUndefined();
  });
});
