/**
 * - `accept`: within budget; handle the frame.
 * - `drop`: over budget; discard it unparsed and unanswered.
 * - `close`: over budget for long enough to be deliberate; close the socket.
 */
export type Admission = 'accept' | 'drop' | 'close';

/**
 * How many frames one socket may send, whatever they contain. Walking speed
 * limits what a `move` can do, but not how many arrive: each is still
 * parsed, validated and answered, so without this a client could flood the
 * process with work that changes nothing.
 *
 * A second's worth of frames may arrive at once, which absorbs anything the
 * network bunched up. Past that, frames are dropped before they are parsed,
 * so a flood costs almost nothing, and the shortfall is kept as a debt.
 * When the debt reaches another second's worth — a client that has kept
 * sending at well over the rate rather than tripping over it once — the
 * socket is closed. The debt refills like the budget does, so a client that
 * bursts once and then behaves recovers without being cut off.
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
    this.frames = Math.min(this.perSecond, this.frames + (elapsed * this.perSecond) / 1000);
    this.refilledAt = Math.max(this.refilledAt, now);

    this.frames -= 1;
    if (this.frames >= 0) return 'accept';
    if (this.frames < -this.perSecond) return 'close';
    return 'drop';
  }
}
