import {
  Direction,
  step,
  tileIndex,
  walkable,
  type Grid,
  type Tile,
} from './grid.js';

/**
 * The fewest steps from `start` to a tile `arrived` accepts, crossing only
 * floor `mayCross` allows; undefined when none can be reached.
 */
export function pathTo(
  grid: Grid,
  start: Tile,
  arrived: (tile: Tile) => boolean,
  mayCross: (tile: Tile) => boolean,
): Direction[] | undefined {
  const cameBy = new Map<number, { from: Tile; direction: Direction }>();
  const seen = new Set([tileIndex(grid, start)]);
  const queue: Tile[] = [{ x: start.x, y: start.y }];
  for (let i = 0; i < queue.length; i += 1) {
    const tile = queue[i] as Tile;
    if (arrived(tile)) {
      const path: Direction[] = [];
      for (let at = tile; ;) {
        const back = cameBy.get(tileIndex(grid, at));
        if (!back) return path.reverse();
        path.push(back.direction);
        at = back.from;
      }
    }
    for (const direction of Object.values(Direction)) {
      const next = step(tile, direction);
      if (!walkable(grid, next)) continue;
      const at = tileIndex(grid, next);
      if (seen.has(at) || !mayCross(next)) continue;
      seen.add(at);
      cameBy.set(at, { from: tile, direction });
      queue.push(next);
    }
  }
  return undefined;
}
