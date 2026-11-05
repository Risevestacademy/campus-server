/**
 * Whether somebody can be approached, as the rest of their cohort sees it on
 * the map. Kept with presence, never in Postgres: it lasts as long as their
 * connection does, and the next one starts Available.
 */
export const Status = {
  Available: 'available',
  Busy: 'busy',
  Away: 'away',
} as const;

export type Status = (typeof Status)[keyof typeof Status];

export const MIN_TIMED_STATUS_SECONDS = 60;
export const MAX_TIMED_STATUS_SECONDS = 12 * 60 * 60;

/**
 * One connection's status: the one they chose, and whether they have gone
 * idle. Idle shows them Away whatever they chose, and activity brings back
 * what they chose — so an Away they chose themselves stays until they choose
 * otherwise, however active they are.
 *
 * Every change returns whether what others see changed, which is all the
 * caller needs to decide whether to tell anybody.
 */
export class Availability {
  private idle = false;

  constructor(
    private chosenStatus: Status,
    /** In ms: the last thing they did. */
    private activeAt: number,
    /** In ms: when a timed choice ends, or null for one that lasts. */
    private untilMs: number | null = null,
    /** What a timed choice goes back to when it ends. */
    private fallback: Status = chosenStatus,
  ) {}

  get chosen(): Status {
    return this.chosenStatus;
  }

  get shown(): Status {
    return this.idle ? Status.Away : this.chosenStatus;
  }

  get until(): number | null {
    return this.untilMs;
  }

  /** Null while idle: the away shown then does not end with the timer. */
  get shownUntil(): number | null {
    return this.idle ? null : this.untilMs;
  }

  /**
   * The same choice for a connection taking this one's place. Its idleness
   * stays behind: the new one is somebody arriving.
   */
  handOver(now: number): Availability {
    return new Availability(
      this.chosenStatus,
      now,
      this.untilMs,
      this.fallback,
    );
  }

  /**
   * Choosing is itself activity. With `forMs`, the choice ends after that
   * long and goes back to the last choice made without one.
   */
  choose(status: Status, now: number, forMs?: number): boolean {
    return this.changes(() => {
      if (forMs === undefined) {
        this.untilMs = null;
        this.fallback = status;
      } else {
        if (this.untilMs === null) this.fallback = this.chosenStatus;
        this.untilMs = now + forMs;
      }
      this.chosenStatus = status;
      this.touch(now);
    });
  }

  /** Ends a timed choice whose time is up. */
  expire(now: number): boolean {
    if (this.untilMs === null || now < this.untilMs) return false;
    return this.changes(() => {
      this.chosenStatus = this.fallback;
      this.untilMs = null;
    });
  }

  active(now: number): boolean {
    return this.changes(() => this.touch(now));
  }

  /** Idle once nothing has happened for `awayAfterMs`. 0 never is. */
  checkIdle(now: number, awayAfterMs: number): boolean {
    if (this.idle || awayAfterMs <= 0 || now - this.activeAt < awayAfterMs) {
      return false;
    }
    return this.changes(() => {
      this.idle = true;
    });
  }

  private changes(change: () => void): boolean {
    const shown = this.shown;
    const shownUntil = this.shownUntil;
    change();
    return this.shown !== shown || this.shownUntil !== shownUntil;
  }

  private touch(now: number): void {
    this.idle = false;
    // The clock can step backwards; that must not make them idle sooner.
    this.activeAt = Math.max(this.activeAt, now);
  }
}
