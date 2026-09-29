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
 * A placeholder map: a walkable rectangle with a spawn tile. Real maps, with
 * walls and spaces, replace it when map geometry loads (W6); until then the
 * edge is the only thing that blocks.
 */
export interface Grid {
  width: number;
  height: number;
  spawn: Tile;
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

export function walkable(grid: Grid, tile: Tile): boolean {
  return tile.x >= 0 && tile.y >= 0 && tile.x < grid.width && tile.y < grid.height;
}
