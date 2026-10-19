import { Direction, step, walkable, type Grid } from './grid.js';

/**
 * An account's place in one cohort's campus: who, and in which campus. The
 * two always travel together, as one value, so a call cannot be handed them
 * the wrong way round. Anything with both fields is one, a connection
 * included.
 */
export interface Seat {
  readonly userId: string;
  readonly cohortId: string;
}

/** A seat as a single string, for keying a map by it. */
export function seatKey({ userId, cohortId }: Seat): string {
  return `${cohortId}\u0000${userId}`;
}

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
 * Keyed by account and cohort: somebody may stand in several cohorts' campuses
 * at once, one avatar in each, and each cohort is its own campus. Within one
 * cohort an account has one avatar, and the socket standing for it may be
 * replaced without the avatar moving.
 *
 * The server decides every position. A client says which way it wants to go,
 * never where it is, so there is no destination to validate and no way to
 * name a tile that is not next to you.
 *
 * Somebody who drops out is remembered for a grace period, invisibly: a
 * connection that blips, or that the server cut for sending too fast or
 * reading too slowly, comes back where it was rather than at the spawn. The
 * memory is per cohort too, so it only ever resumes in the campus it was left.
 */
export class Players {
  /** Cohort, then account. */
  private readonly standing = new Map<string, Map<string, Held>>();
  /** Left recently, and may come back to where they stood until `until`. */
  private readonly departed = new Map<
    string,
    Map<string, { held: Held; until: number }>
  >();

  constructor(
    private readonly grid: Grid,
    /** Fastest a player may walk: one tile per this many milliseconds. */
    private readonly stepMs: number,
    /** How long somebody who left is remembered. 0 forgets them at once. */
    private readonly graceMs: number = 0,
  ) {}

  /**
   * Places somebody on one cohort's map: where they stood there if they left
   * within the grace period, else where they last stood on an earlier visit
   * (`saved`, if that tile is still walkable), else at the spawn. Returns the
   * existing player if they are already standing in this cohort.
   */
  join(
    { userId, cohortId }: Seat,
    now: number,
    saved?: Pick<Player, 'x' | 'y' | 'facing'>,
  ): Player {
    const existing = this.standing.get(cohortId)?.get(userId);
    if (existing) {
      return { ...existing.player };
    }

    const remembered = this.departed.get(cohortId)?.get(userId);
    deleteIn(this.departed, { userId, cohortId });
    if (remembered && remembered.until > now) {
      // The step allowance comes back as it was: leaving and rejoining must
      // not be a way to refill it.
      setIn(this.standing, { userId, cohortId }, remembered.held);
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
    setIn(
      this.standing,
      { userId, cohortId },
      {
        player,
        steps: STEP_BURST,
        refilledAt: now,
      },
    );
    return { ...player };
  }

  /**
   * Takes somebody off one cohort's map. True if they were on it. Their
   * avatars in other cohorts are untouched.
   *
   * With `remember`, where they stood is kept for the grace period, so a
   * reconnect to this cohort resumes there. Without it they are forgotten in
   * this cohort entirely — for access being taken away, where there is
   * nothing to come back to.
   */
  leave({ userId, cohortId }: Seat, now: number, remember: boolean): boolean {
    const held = this.standing.get(cohortId)?.get(userId);
    if (!remember) {
      deleteIn(this.departed, { userId, cohortId });
    }
    if (!held) {
      return false;
    }
    deleteIn(this.standing, { userId, cohortId });
    if (remember && this.graceMs > 0) {
      setIn(
        this.departed,
        { userId, cohortId },
        {
          held,
          until: now + this.graceMs,
        },
      );
    }
    return true;
  }

  /**
   * Drops remembered positions whose grace has run out. `join` ignores an
   * expired one anyway; this only stops people who never come back from
   * being held in memory for good.
   */
  forgetExpired(now: number): void {
    for (const [cohortId, inCohort] of this.departed) {
      for (const [userId, remembered] of inCohort) {
        if (remembered.until <= now) {
          deleteIn(this.departed, { userId, cohortId });
        }
      }
    }
  }

  /**
   * Whether a position is still held in this cohort for somebody who left
   * it. May be true for a moment after their grace has run out, until the
   * next `forgetExpired`; `join` checks the time itself, so that never
   * resumes anybody late.
   */
  isRemembered({ userId, cohortId }: Seat): boolean {
    return this.departed.get(cohortId)?.has(userId) ?? false;
  }

  /**
   * How many positions are held for people who left, including any whose
   * grace has run out since the last `forgetExpired`.
   */
  get remembered(): number {
    let count = 0;
    for (const inCohort of this.departed.values()) count += inCohort.size;
    return count;
  }

  get({ userId, cohortId }: Seat): Player | undefined {
    const held = this.standing.get(cohortId)?.get(userId);
    return held ? { ...held.player } : undefined;
  }

  has({ userId, cohortId }: Seat): boolean {
    return this.standing.get(cohortId)?.has(userId) ?? false;
  }

  /** Everybody standing in one cohort's campus. */
  in(cohortId: string): Player[] {
    return [...(this.standing.get(cohortId)?.values() ?? [])].map((held) => ({
      ...held.player,
    }));
  }

  /** Avatars on every cohort's map; one person in two cohorts counts twice. */
  get size(): number {
    let count = 0;
    for (const inCohort of this.standing.values()) count += inCohort.size;
    return count;
  }

  move(
    { userId, cohortId }: Seat,
    direction: Direction,
    now: number,
  ): MoveResult {
    const held = this.standing.get(cohortId)?.get(userId);
    if (!held) {
      // Every connection joins before its first frame is read, so this is a
      // bug in the caller rather than something a client can cause.
      throw new Error(
        `move for a player who has not joined: ${userId} in ${cohortId}`,
      );
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

/** Cohort, then account: each cohort's campus kept together. */
function setIn<T>(
  outer: Map<string, Map<string, T>>,
  { userId, cohortId }: Seat,
  value: T,
): void {
  let inner = outer.get(cohortId);
  if (!inner) {
    inner = new Map();
    outer.set(cohortId, inner);
  }
  inner.set(userId, value);
}

function deleteIn<T>(
  outer: Map<string, Map<string, T>>,
  { userId, cohortId }: Seat,
): void {
  const inner = outer.get(cohortId);
  if (!inner) return;
  inner.delete(userId);
  if (inner.size === 0) outer.delete(cohortId);
}
