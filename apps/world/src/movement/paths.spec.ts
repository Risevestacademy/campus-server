import { describe, expect, it } from 'vitest';

import {
  step,
  tileIndex,
  type Direction,
  type Grid,
  type Tile,
} from './grid.js';
import { pathTo } from './paths.js';

/** 5 × 3, with a wall down the middle column except at the bottom row. */
const walls = new Uint8Array(5 * 3);
walls[tileIndex({ width: 5 }, { x: 2, y: 0 })] = 1;
walls[tileIndex({ width: 5 }, { x: 2, y: 1 })] = 1;
const grid: Grid = { width: 5, height: 3, spawn: { x: 0, y: 0 }, walls };

const at = (goal: Tile) => (tile: Tile) =>
  tile.x === goal.x && tile.y === goal.y;
const anywhere = () => true;

const walk = (from: Tile, path: Direction[]) =>
  path.reduce((tile, direction) => step(tile, direction), from);

describe('pathTo', () => {
  it('goes round a wall by the fewest steps', () => {
    const path = pathTo(grid, { x: 0, y: 0 }, at({ x: 4, y: 0 }), anywhere);

    expect(path).toHaveLength(8);
    expect(walk({ x: 0, y: 0 }, path ?? [])).toEqual({ x: 4, y: 0 });
  });

  it('is empty when the start is where it was going', () => {
    expect(pathTo(grid, { x: 1, y: 1 }, at({ x: 1, y: 1 }), anywhere)).toEqual(
      [],
    );
  });

  it('never crosses floor it may not', () => {
    const notTheGap = (tile: Tile) => !(tile.x === 2 && tile.y === 2);

    expect(
      pathTo(grid, { x: 0, y: 0 }, at({ x: 4, y: 0 }), notTheGap),
    ).toBeUndefined();
  });

  it('stops at the nearest tile it accepts', () => {
    const rightHalf = (tile: Tile) => tile.x >= 3;

    expect(
      walk(
        { x: 0, y: 0 },
        pathTo(grid, { x: 0, y: 0 }, rightHalf, anywhere) ?? [],
      ),
    ).toEqual({ x: 3, y: 2 });
  });
});
