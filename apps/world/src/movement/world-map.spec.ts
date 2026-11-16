import type { MapLayout } from 'campus-world-map';
import { describe, expect, it } from 'vitest';

import { walkable } from './grid.js';
import { gridFrom } from './world-map.js';

/** 4 × 3: a wall across the top-right, a triangle in the bottom-left. */
const layout: MapLayout = {
  widthTiles: 4,
  heightTiles: 3,
  collisions: [
    { shape: 'rect', x: 2, y: 0, width: 2, height: 1 },
    {
      shape: 'polygon',
      points: [
        { x: 0, y: 1 },
        { x: 0, y: 3 },
        { x: 2, y: 3 },
      ],
    },
  ],
  spawn: { x: 0, y: 0 },
  spaces: [],
  portals: [],
  desks: [],
};

describe('gridFrom', () => {
  it('walls off every tile a collision shape covers the middle of', () => {
    const grid = gridFrom(layout);

    const rows = Array.from({ length: grid.height }, (_, y) =>
      Array.from({ length: grid.width }, (_, x) =>
        walkable(grid, { x, y }) ? '.' : '#',
      ).join(''),
    );
    // The triangle's edge crosses (0,1) and (1,2) but not their middles.
    expect(rows).toEqual(['..##', '....', '#...']);
  });

  it('keeps the size and the spawn the map was published with', () => {
    expect(gridFrom(layout)).toMatchObject({
      width: 4,
      height: 3,
      spawn: { x: 0, y: 0 },
    });
  });

  /** Only the entry map has one; any other could place nobody. */
  it('refuses a map with no spawn', () => {
    expect(() => gridFrom({ ...layout, spawn: null })).toThrow(/no spawn/);
  });
});
