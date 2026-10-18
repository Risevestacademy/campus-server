import { DEFAULT_SPACE_KEY } from '@campus/session';
import type { MapLayout } from 'campus-world-map';
import { describe, expect, it } from 'vitest';

import { emptySpaceIndex, spaceAt, spaceIndexFrom } from './spaces.js';

type Drawn = MapLayout['spaces'][number];

const rect = (
  key: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Drawn => ({
  key,
  name: key,
  kind: null,
  bounds: { shape: 'rect', x, y, width, height },
  properties: {},
});

/** 10 × 6 tiles, with whatever spaces a test draws on it. */
const layout = (spaces: Drawn[]): MapLayout => ({
  widthTiles: 10,
  heightTiles: 6,
  collisions: [],
  spawn: { x: 0, y: 0 },
  spaces,
  portals: [],
  desks: [],
});

describe('spaceAt', () => {
  it('names the drawn space a tile is in, and the default space for the rest', () => {
    const index = spaceIndexFrom(layout([rect('library', 2, 1, 3, 2)]));

    expect(spaceAt(index, { x: 2, y: 1 })).toBe('library');
    expect(spaceAt(index, { x: 4, y: 2 })).toBe('library');
    // Just outside, on each side the rectangle stops.
    expect(spaceAt(index, { x: 5, y: 1 })).toBe(DEFAULT_SPACE_KEY);
    expect(spaceAt(index, { x: 2, y: 3 })).toBe(DEFAULT_SPACE_KEY);
    expect(spaceAt(index, { x: 1, y: 1 })).toBe(DEFAULT_SPACE_KEY);
  });

  /** The middle of the tile decides, as it does for walls. */
  it('counts a tile in a space when the space covers its middle', () => {
    const index = spaceIndexFrom(
      layout([
        {
          ...rect('nook', 0, 0, 0, 0),
          // From 1.4 to 2.4 each way: the middle of (1, 1) but not of (2, 2).
          bounds: { shape: 'rect', x: 1.4, y: 1.4, width: 1, height: 1 },
        },
      ]),
    );

    expect(spaceAt(index, { x: 1, y: 1 })).toBe('nook');
    expect(spaceAt(index, { x: 2, y: 2 })).toBe(DEFAULT_SPACE_KEY);
  });

  it('follows the outline of a space drawn as a polygon', () => {
    // A right triangle with its corner at the top left.
    const index = spaceIndexFrom(
      layout([
        {
          ...rect('corner', 0, 0, 0, 0),
          bounds: {
            shape: 'polygon',
            points: [
              { x: 0, y: 0 },
              { x: 6, y: 0 },
              { x: 0, y: 6 },
            ],
          },
        },
      ]),
    );

    expect(spaceAt(index, { x: 0, y: 0 })).toBe('corner');
    expect(spaceAt(index, { x: 4, y: 0 })).toBe('corner');
    expect(spaceAt(index, { x: 5, y: 5 })).toBe(DEFAULT_SPACE_KEY);
  });

  /** A booth drawn inside a hall is the booth, not the hall. */
  it('gives a tile in two spaces to the smaller', () => {
    const drawn = [rect('hall', 0, 0, 8, 6), rect('booth', 2, 2, 2, 2)];

    for (const spaces of [drawn, [...drawn].reverse()]) {
      const index = spaceIndexFrom(layout(spaces));
      expect(spaceAt(index, { x: 2, y: 2 })).toBe('booth');
      expect(spaceAt(index, { x: 6, y: 4 })).toBe('hall');
    }
  });

  it('gives a tile in two spaces of one size to the key that sorts first, either way round', () => {
    const drawn = [rect('west', 0, 0, 4, 4), rect('east', 2, 0, 4, 4)];

    for (const spaces of [drawn, [...drawn].reverse()]) {
      const index = spaceIndexFrom(layout(spaces));
      expect(spaceAt(index, { x: 3, y: 1 })).toBe('east');
      expect(spaceAt(index, { x: 0, y: 1 })).toBe('west');
      expect(spaceAt(index, { x: 5, y: 1 })).toBe('east');
    }
  });

  /** Ordered by character, so `Z` sorts before `a` wherever this runs. */
  it('breaks a tie by the keys as written, not by any locale', () => {
    const index = spaceIndexFrom(
      layout([rect('alcove', 0, 0, 2, 2), rect('Zone', 0, 0, 2, 2)]),
    );

    expect(spaceAt(index, { x: 0, y: 0 })).toBe('Zone');
  });

  it('puts a tile off the map in the default space', () => {
    const index = spaceIndexFrom(layout([rect('all', 0, 0, 10, 6)]));

    for (const tile of [
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 10, y: 0 },
      { x: 0, y: 6 },
    ]) {
      expect(spaceAt(index, tile)).toBe(DEFAULT_SPACE_KEY);
    }
  });

  it('has every tile of a map with no drawn spaces in the default space', () => {
    for (const index of [spaceIndexFrom(layout([])), emptySpaceIndex(10, 6)]) {
      expect(spaceAt(index, { x: 3, y: 3 })).toBe(DEFAULT_SPACE_KEY);
      expect(index.keys).toEqual([]);
    }
  });
});
