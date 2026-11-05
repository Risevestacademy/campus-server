/**
 * Who, and in which cohort's campus. One value, so the two cannot be passed
 * positionally the wrong way round; anything with both fields is one, a
 * connection included.
 */
export interface Seat {
  readonly userId: string;
  readonly cohortId: string;
}

/** A seat as one string, for keying a map in memory. Never stored. */
export function seatKey({ userId, cohortId }: Seat): string {
  return `${cohortId}\u0000${userId}`;
}

/**
 * A map keyed by seat rather than by a string a caller had to encode. Iterates
 * its values, in insertion order, as the plain Map it holds would.
 */
export class SeatMap<T> {
  private readonly entries = new Map<string, T>();

  get(seat: Seat): T | undefined {
    return this.entries.get(seatKey(seat));
  }

  set(seat: Seat, value: T): this {
    this.entries.set(seatKey(seat), value);
    return this;
  }

  has(seat: Seat): boolean {
    return this.entries.has(seatKey(seat));
  }

  delete(seat: Seat): boolean {
    return this.entries.delete(seatKey(seat));
  }

  values(): IterableIterator<T> {
    return this.entries.values();
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.entries.values();
  }
}
