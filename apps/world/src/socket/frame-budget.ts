/**
 * - `accept`: within budget; handle the frame.
 * - `close`: over budget; close before parsing the excess frame.
 */
export type Admission = 'accept' | 'close';

/**
 * How many frames one socket may send, whatever they contain. Walking speed
 * limits what a `move` can do, but not how many arrive: each is still
 * parsed, validated and answered, so without this a client could flood the
 * process with work that changes nothing.
 *
 * A second's worth of frames may arrive at once. The first frame past that
 * closes the socket before parsing. Closing instead of silently dropping
 * preserves synchronization through the reconnect snapshot.
 */
export class FrameBudget {
  private frames: number;
  private refilledAt: number;

  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.frames = perSecond;
    this.refilledAt = now;
  }

  admit(now: number): Admission {
    // Date.now() can step backwards when the clock is corrected; that must
    // not count against the client.
    const elapsed = Math.max(0, now - this.refilledAt);
    this.frames = Math.min(
      this.perSecond,
      this.frames + (elapsed * this.perSecond) / 1000,
    );
    this.refilledAt = Math.max(this.refilledAt, now);

    if (this.frames < 1) return 'close';

    this.frames -= 1;
    return 'accept';
  }
}
