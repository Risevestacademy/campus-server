/**
 * How many connection checks one account may start per minute, counted per
 * account rather than per address: everybody behind one campus network
 * shares an address, and the check is only open to the signed in.
 */
export class CheckBudget {
  private readonly windows = new Map<
    string,
    { used: number; resetsAt: number }
  >();
  private sweptAt: number;

  constructor(
    private readonly perMinute: number,
    now: number,
  ) {
    this.sweptAt = now;
  }

  /** Seconds until the account may try again, or 0 if this one is allowed. */
  take(userId: string, now: number): number {
    this.sweep(now);

    let window = this.windows.get(userId);
    if (!window || now >= window.resetsAt) {
      window = { used: 0, resetsAt: now + WINDOW_MS };
      this.windows.set(userId, window);
    }
    if (window.used >= this.perMinute) {
      return Math.max(1, Math.ceil((window.resetsAt - now) / 1000));
    }
    window.used += 1;
    return 0;
  }

  /** At most once a window, so the map holds only accounts seen lately. */
  private sweep(now: number): void {
    if (now - this.sweptAt < WINDOW_MS) return;
    this.sweptAt = now;
    for (const [userId, window] of this.windows) {
      if (now >= window.resetsAt) this.windows.delete(userId);
    }
  }
}

const WINDOW_MS = 60_000;
