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
 *
 * Somebody who drops out is remembered for a grace period, invisibly: a
 * connection that blips, or that the server cut for sending too fast or
 * reading too slowly, comes back where it was rather than at the spawn.
 */
export class Players {
  private readonly byUser = new Map<string, Held>();
  /** Left recently, and may come back to where they stood until `until`. */
  private readonly departed = new Map<string, { held: Held; until: number }>();

  constructor(
    private readonly grid: Grid,
    /** Fastest a player may walk: one tile per this many milliseconds. */
    private readonly stepMs: number,
    /** How long somebody who left is remembered. 0 forgets them at once. */
    private readonly graceMs: number = 0,
  ) {}

  /**
   * Places somebody on the map: where they stood if they left within the
   * grace period, else where they last stood on an earlier visit (`saved`,
   * if that tile is still walkable), else at the spawn. Returns the existing
   * player if they are already here.
   */
  join(
    userId: string,
    now: number,
    saved?: Pick<Player, 'x' | 'y' | 'facing'>,
  ): Player {
    const existing = this.byUser.get(userId);
    if (existing) {
      return { ...existing.player };
    }

    const remembered = this.departed.get(userId);
    this.departed.delete(userId);
    if (remembered && remembered.until > now) {
      // The step allowance comes back as it was: leaving and rejoining must
      // not be a way to refill it.
      this.byUser.set(userId, remembered.held);
      return { ...remembered.held.player };
    }

    // A map can change between visits: a tile that was floor may be a wall
    // now, or off the edge. Standing somebody somewhere they could never have
    // walked to is worse than the spawn.
    const player: Player =
      saved && walkable(this.grid, saved)
        ? { userId, x: saved.x, y: saved.y, facing: saved.facing }
        : {
            userId,
            x: this.grid.spawn.x,
            y: this.grid.spawn.y,
            facing: Direction.Down,
          };
    this.byUser.set(userId, { player, steps: STEP_BURST, refilledAt: now });
    return { ...player };
  }

  /**
   * Takes somebody off the map. True if they were on it.
   *
   * With `remember`, where they stood is kept for the grace period so a
   * reconnect resumes there. Without it they are forgotten entirely — for
   * access being taken away, where there is nothing to come back to.
   */
  leave(userId: string, now: number, remember: boolean): boolean {
    const held = this.byUser.get(userId);
    if (!remember) {
      this.departed.delete(userId);
    }
    if (!held) {
      return false;
    }
    this.byUser.delete(userId);
    if (remember && this.graceMs > 0) {
      this.departed.set(userId, { held, until: now + this.graceMs });
    }
    return true;
  }

  /**
   * Drops remembered positions whose grace has run out. `join` ignores an
   * expired one anyway; this only stops people who never come back from
   * being held in memory for good.
   */
  forgetExpired(now: number): void {
    for (const [userId, remembered] of this.departed) {
      if (remembered.until <= now) {
        this.departed.delete(userId);
      }
    }
  }

  /**
   * Whether a position is still held for somebody who left. May be true for
   * a moment after their grace has run out, until the next `forgetExpired`;
   * `join` checks the time itself, so that never resumes anybody late.
   */
  isRemembered(userId: string): boolean {
    return this.departed.has(userId);
  }

  /**
   * How many positions are held for people who left, including any whose
   * grace has run out since the last `forgetExpired`.
   */
  get remembered(): number {
    return this.departed.size;
  }

  get(userId: string): Player | undefined {
    const held = this.byUser.get(userId);
    return held ? { ...held.player } : undefined;
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
