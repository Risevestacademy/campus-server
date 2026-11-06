import { blocked, type MapLayout } from 'campus-world-map';

import { tileIndex, walkable, type Grid, type Tile } from './grid.js';
import { emptySpaceIndex, floorByMiddle, type SpaceIndex } from './spaces.js';

/**
 * The map this process enforces, and which published version of it. Loaded
 * once: a publish while people are walking must not move the walls under
 * them, so a new version is only picked up by a restart.
 */
export interface WorldMap {
  id: string;
  version: string;
  grid: Grid;
  /** Which space each tile is in. See spaceAt. */
  spaces: SpaceIndex;
}

/**
 * What development falls back to when no published map can be loaded: an
 * open rectangle where the edge is the only thing that blocks. Its id and
 * version name nothing in Sanity, so a client cannot mistake it for a map it
 * could load.
 */
export const PLACEHOLDER_MAP: WorldMap = {
  id: 'placeholder',
  version: 'placeholder',
  grid: { width: 40, height: 30, spawn: { x: 20, y: 15 } },
  // No drawn spaces: every tile is in the default one.
  spaces: emptySpaceIndex(40, 30),
};

/**
 * Turns a map's layout into the grid movement walks on, testing every tile
 * against the collision shapes once, here, with the same `blocked` the
 * publisher and campus-web use — so all three agree on which tiles are wall.
 */
export function gridFrom(layout: MapLayout): Grid {
  if (!layout.spawn) {
    throw new Error('the map has no spawn, so nobody could arrive on it');
  }
  const { widthTiles: width, heightTiles: height } = layout;
  const walls = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (blocked(layout, { x, y })) {
        walls[tileIndex({ width }, { x, y })] = 1;
      }
    }
  }
  return { width, height, spawn: layout.spawn, walls };
}

/**
 * What a map must be before world can run on it. `gridFrom` already refuses
 * one with no spawn; these are the failures that would leave somebody
 * standing nowhere or seal a drawn space, and they stop a reload before it
 * is swapped in. Checked on a built `WorldMap`, so a loader cannot hand one
 * over unchecked.
 */
export function assertWorldMap(map: WorldMap): void {
  if (map.grid.width <= 0 || map.grid.height <= 0) {
    throw new Error(`map "${map.id}" has no tiles`);
  }
  if (!walkable(map.grid, map.grid.spawn)) {
    throw new Error(`map "${map.id}" spawns on a wall`);
  }
  for (const spaceKey of map.spaces.keys) {
    const floor: Tile[] = floorByMiddle(map.grid, map.spaces, spaceKey);
    if (floor.length === 0) {
      throw new Error(
        `space "${spaceKey}" on "${map.id}" has no walkable tile`,
      );
    }
  }
}
