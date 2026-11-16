/**
 * The world is a grid of tiles, as Gather's is. A position is a tile, never a
 * pixel: the tile's pixel size belongs to the client, which multiplies by it
 * to draw, so nothing here changes when the art does.
 *
 * x grows rightward and y grows downward, the way the screen does, so "up"
 * is y - 1.
 */
export const Direction = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

export interface Tile {
  x: number;
  y: number;
}

/**
 * One map, as movement needs it: its size, where people first appear, and
 * which tiles nobody can stand on.
 */
export interface Grid {
  width: number;
  height: number;
  spawn: Tile;
  /**
   * One entry per tile, row by row, non-zero where a wall stands. Worked out
   * once when the map loads, so a step is a lookup rather than a test against
   * every collision shape. Left out, the edge is the only thing that blocks.
   */
  walls?: Uint8Array;
}

const OFFSETS: Record<Direction, Tile> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function step(from: Tile, direction: Direction): Tile {
  const offset = OFFSETS[direction];
  return { x: from.x + offset.x, y: from.y + offset.y };
}

/** Where a tile sits in `walls`: row by row, from the top left. */
export function tileIndex(grid: Pick<Grid, 'width'>, tile: Tile): number {
  return tile.y * grid.width + tile.x;
}

export function walkable(grid: Grid, tile: Tile): boolean {
  if (
    tile.x < 0 ||
    tile.y < 0 ||
    tile.x >= grid.width ||
    tile.y >= grid.height
  ) {
    return false;
  }
  return !grid.walls?.[tileIndex(grid, tile)];
}

/**
 * The walkable tile nearest `start`, by steps, or undefined when none can be
 * reached. The tile itself wins when it is walkable. Ties go to the first
 * found in Direction order (up, down, left, right), which is the order a
 * staff removal searches in, so every instance picks the same tile for the
 * same map.
 */
export function nearestWalkable(grid: Grid, start: Tile): Tile | undefined {
  const queue: Tile[] = [{ x: start.x, y: start.y }];
  const seen = new Set([`${start.x},${start.y}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const tile = queue[i] as Tile;
    if (walkable(grid, tile)) return tile;
    for (const direction of Object.values(Direction)) {
      const next = step(tile, direction);
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= grid.width ||
        next.y >= grid.height
      ) {
        continue;
      }
      const key = `${next.x},${next.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return undefined;
}
