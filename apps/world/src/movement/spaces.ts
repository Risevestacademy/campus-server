import { DEFAULT_SPACE_KEY } from '@campus/session';
import { contains, type MapLayout } from 'campus-world-map';

import { tileIndex, type Tile } from './grid.js';

/**
 * Which space each tile of a map is in, worked out once when the map loads,
 * so asking is a lookup rather than a test against every shape. A tile in no
 * drawn space is in the map's default space.
 */
export interface SpaceIndex {
  width: number;
  height: number;
  /** The drawn spaces' keys. `tiles` holds 1 for the first, 2 for the next. */
  keys: readonly string[];
  /** One entry per tile, row by row; 0 for the default space. */
  tiles: Uint16Array;
}

/**
 * A tile is in a space when the space covers the tile's middle, the same
 * test `blocked` makes for walls and campus-web makes when it draws.
 *
 * Spaces may overlap: a booth drawn inside a hall. A tile in more than one is
 * in the smallest, counted in tiles, since the space drawn inside another is
 * the one the designer meant there. Two of the same size go to the key that
 * sorts first, so the answer never depends on the order the map lists them.
 */
export function spaceIndexFrom(layout: MapLayout): SpaceIndex {
  const { widthTiles: width, heightTiles: height } = layout;
  // By the keys' characters, not localeCompare, whose order depends on the
  // machine's locale: two instances must not disagree about a tile.
  const spaces = [...layout.spaces].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  if (spaces.length >= 0xffff) {
    throw new Error(`the map draws ${spaces.length} spaces; at most 65534 fit`);
  }

  const inside = (tile: Tile) =>
    spaces.flatMap((space, i) =>
      contains(space.bounds, { x: tile.x + 0.5, y: tile.y + 0.5 }) ? [i] : [],
    );

  // Sizes first, so a tile in several spaces can be given the smallest.
  const sizes = new Array<number>(spaces.length).fill(0);
  const covering: number[][] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const found = inside({ x, y });
      covering.push(found);
      for (const i of found) sizes[i] += 1;
    }
  }

  const tiles = new Uint16Array(width * height);
  covering.forEach((found, at) => {
    if (found.length === 0) return;
    // `spaces` is in key order, so the first of the smallest is the one.
    const smallest = found.reduce((best, i) =>
      sizes[i] < sizes[best] ? i : best,
    );
    tiles[at] = smallest + 1;
  });
  return { width, height, keys: spaces.map((space) => space.key), tiles };
}

/** A map whose every tile is in its default space. */
export function emptySpaceIndex(width: number, height: number): SpaceIndex {
  return { width, height, keys: [], tiles: new Uint16Array(width * height) };
}

/**
 * The key of the space a tile is in: a drawn space's key, or the default
 * space's for a tile in none. A tile off the map is in no drawn space either.
 */
export function spaceAt(index: SpaceIndex, tile: Tile): string {
  if (
    tile.x < 0 ||
    tile.y < 0 ||
    tile.x >= index.width ||
    tile.y >= index.height
  ) {
    return DEFAULT_SPACE_KEY;
  }
  const at = index.tiles[tileIndex(index, tile)];
  return at === 0 ? DEFAULT_SPACE_KEY : (index.keys[at - 1] as string);
}
