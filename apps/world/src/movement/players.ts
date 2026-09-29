import { Direction, step, walkable, type Grid } from './grid.js';

/** Where somebody stands, and which way they face. What other clients draw. */
export interface Player {
  userId: string;
  x: number;
  y: number;
  facing: Direction;
}

/**
 * - `moved`: one tile in the direction asked.
 * - `blocked`: the tile is not walkable. They still turn to face it, as they
 *   would walking into a wall, so `changed` may be true.
 * - `too_fast`: over the walking speed. Nothing happens, not even the turn.
 */
export type MoveOutcome = 'moved' | 'blocked' | 'too_fast';

export interface MoveResult {
  outcome: MoveOutcome;
  /** Where they stand afterwards, whatever the outcome. */
  player: Player;
  /** Whether anybody else's view of them is now out of date. */
  changed: boolean;
}

/**
 * Steps a player may take back to back before the walking speed applies.
 * Frames bunch up on the way here — a phone on patchy signal delivers three
 * held-back steps at once — and refusing the second of those would snap a
 * player who did nothing wrong back across the map. A few steps of slack
 * absorbs that without letting anybody outrun the speed for more than a
 * moment.
 */
export const STEP_BURST = 3;

interface Held {
  player: Player;
  /** Steps available now, refilled one per stepMs up to STEP_BURST. */
  steps: number;
  refilledAt: number;
}

/**
 * Who is standing where, in this process. In memory by design: positions
 * change many times a second and are worthless a moment later, which is why
 * the TRD keeps them out of Postgres.
 *
 * Keyed by user rather than by socket: somebody with two tabs is one person
 * standing in one place, and either tab walks the same avatar.
 *
 * The server decides every position. A client says which way it wants to go,
 * never where it is, so there is no destination to validate and no way to
 * name a tile that is not next to you.
 */
export class Players {
  private readonly byUser = new Map<string, Held>();

  constructor(
    private readonly grid: Grid,
    /** Fastest a player may walk: one tile per this many milliseconds. */
    private readonly stepMs: number,
  ) {}

  /** Places somebody at the spawn tile. Returns the existing player if they are already here. */
  join(userId: string, now: number): Player {
    const existing = this.byUser.get(userId);
    if (existing) {
      return { ...existing.player };
    }
    const player: Player = {
      userId,
      x: this.grid.spawn.x,
      y: this.grid.spawn.y,
      facing: Direction.Down,
    };
    this.byUser.set(userId, { player, steps: STEP_BURST, refilledAt: now });
    return { ...player };
  }

  /** True if they were here to remove. */
  leave(userId: string): boolean {
    return this.byUser.delete(userId);
  }

  has(userId: string): boolean {
    return this.byUser.has(userId);
  }

  all(): Player[] {
    return [...this.byUser.values()].map((held) => ({ ...held.player }));
  }

  get size(): number {
    return this.byUser.size;
  }

  move(userId: string, direction: Direction, now: number): MoveResult {
    const held = this.byUser.get(userId);
    if (!held) {
      // Every connection joins before its first frame is read, so this is a
      // bug in the caller rather than something a client can cause.
      throw new Error(`move for a player who has not joined: ${userId}`);
    }

    this.refill(held, now);
    if (held.steps < 1) {
      return {
        outcome: 'too_fast',
        player: { ...held.player },
        changed: false,
      };
    }
    // Spent on a blocked step too: walking into a wall still takes the time
    // a step takes, and otherwise a client could spin in place for free.
    held.steps -= 1;

    const turned = held.player.facing !== direction;
    held.player.facing = direction;

    const target = step(held.player, direction);
    if (!walkable(this.grid, target)) {
      return {
        outcome: 'blocked',
        player: { ...held.player },
        changed: turned,
      };
    }

    held.player.x = target.x;
    held.player.y = target.y;
    return { outcome: 'moved', player: { ...held.player }, changed: true };
  }

  private refill(held: Held, now: number): void {
    // Date.now() can step backwards when the system clock is corrected; that
    // must not take away steps somebody already had.
    const earned = Math.max(0, now - held.refilledAt) / this.stepMs;
    held.steps = Math.min(STEP_BURST, held.steps + earned);
    held.refilledAt = Math.max(held.refilledAt, now);
  }
}
