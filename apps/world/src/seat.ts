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
