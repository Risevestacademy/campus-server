import {
  Direction,
  step,
  walkable,
  type Grid,
  type Tile,
} from '../movement/grid.js';
import { spaceAt, type SpaceIndex } from '../movement/spaces.js';
import { seatKey, type Seat } from '../seat.js';

/** How long somebody staff removed from a space is kept out of it. */
export const REMOVED_FOR_MS = 90_000;

/**
 * Who staff removed from which space, per cohort, and until when. In this
 * process like the locks: a restart takes everybody out anyway.
 */
export class SpaceRemovals {
  private readonly until = new Map<string, number>();

  /** Keeps them out from `now`, and returns until when. */
  remove(seat: Seat, spaceKey: string, now: number): number {
    for (const [k, until] of this.until) {
      if (until <= now) this.until.delete(k);
    }
    const until = now + REMOVED_FOR_MS;
    this.until.set(key(seat, spaceKey), until);
    return until;
  }

  isRemoved(seat: Seat, spaceKey: string, now: number): boolean {
    const k = key(seat, spaceKey);
    const until = this.until.get(k);
    if (until === undefined) return false;
    if (until > now) return true;
    this.until.delete(k);
    return false;
  }

  get size(): number {
    return this.until.size;
  }
}

/**
 * The nearest floor outside `leaving`, by steps from `start`, in a space
 * they may stand in; the spawn when there is none.
 */
export function nearestOutside(
  grid: Grid,
  spaces: SpaceIndex,
  start: Tile,
  leaving: string,
  mayStandIn: (spaceKey: string) => boolean,
): Tile {
  const queue: Tile[] = [{ x: start.x, y: start.y }];
  const seen = new Set([`${start.x},${start.y}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const tile = queue[i] as Tile;
    const into = spaceAt(spaces, tile);
    if (into !== leaving && mayStandIn(into)) return tile;
    for (const direction of Object.values(Direction)) {
      const next = step(tile, direction);
      const k = `${next.x},${next.y}`;
      if (seen.has(k) || !walkable(grid, next)) continue;
      seen.add(k);
      queue.push(next);
    }
  }
  return grid.spawn;
}

function key(seat: Seat, spaceKey: string): string {
  return `${seatKey(seat)}\u0000${spaceKey}`;
}
