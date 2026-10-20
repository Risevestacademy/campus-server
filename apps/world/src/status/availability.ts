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
  ) {}

  get chosen(): Status {
    return this.chosenStatus;
  }

  get shown(): Status {
    return this.idle ? Status.Away : this.chosenStatus;
  }

  /** Choosing is itself activity. */
  choose(status: Status, now: number): boolean {
    const before = this.shown;
    this.chosenStatus = status;
    this.touch(now);
    return this.shown !== before;
  }

  active(now: number): boolean {
    const before = this.shown;
    this.touch(now);
    return this.shown !== before;
  }

  /** Idle once nothing has happened for `awayAfterMs`. 0 never is. */
  checkIdle(now: number, awayAfterMs: number): boolean {
    if (this.idle || awayAfterMs <= 0 || now - this.activeAt < awayAfterMs) {
      return false;
    }
    const before = this.shown;
    this.idle = true;
    return this.shown !== before;
  }

  private touch(now: number): void {
    this.idle = false;
    // The clock can step backwards; that must not make them idle sooner.
    this.activeAt = Math.max(this.activeAt, now);
  }
}
