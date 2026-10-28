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

const NOBODY: ReadonlyMap<string, never> = new Map<string, never>();

/**
 * A map keyed by seat. Cohort, then account: each cohort's campus is kept
 * together, and iteration goes one cohort at a time. A second index by
 * account answers "this account, in whichever cohorts" without a scan.
 *
 * Only the two ids are kept, never the object passed as the seat, so a
 * connection can be the key without being held in memory by it.
 */
export class SeatMap<T> implements Iterable<[Seat, T]> {
  /** Cohort, then account. */
  private readonly byCohort = new Map<string, Map<string, T>>();
  /** Account, then cohort: the same entries, the other way round. */
  private readonly byAccount = new Map<string, Map<string, T>>();
  private count = 0;

  get({ userId, cohortId }: Seat): T | undefined {
    return this.byCohort.get(cohortId)?.get(userId);
  }

  has({ userId, cohortId }: Seat): boolean {
    return this.byCohort.get(cohortId)?.has(userId) ?? false;
  }

  set(seat: Seat, value: T): this {
    if (!this.has(seat)) this.count += 1;
    put(this.byCohort, seat.cohortId, seat.userId, value);
    put(this.byAccount, seat.userId, seat.cohortId, value);
    return this;
  }

  delete(seat: Seat): boolean {
    if (!this.has(seat)) return false;
    this.count -= 1;
    remove(this.byCohort, seat.cohortId, seat.userId);
    remove(this.byAccount, seat.userId, seat.cohortId);
    return true;
  }

  clear(): void {
    this.byCohort.clear();
    this.byAccount.clear();
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Accounts with at least one entry, however many cohorts they are in. */
  get accounts(): number {
    return this.byAccount.size;
  }

  /** Everybody in one cohort, by account. Live, not a copy. */
  inCohort(cohortId: string): ReadonlyMap<string, T> {
    return this.byCohort.get(cohortId) ?? NOBODY;
  }

  /** One account in every cohort it is in, by cohort. Live, not a copy. */
  ofAccount(userId: string): ReadonlyMap<string, T> {
    return this.byAccount.get(userId) ?? NOBODY;
  }

  *entries(): IterableIterator<[Seat, T]> {
    for (const [cohortId, inCohort] of this.byCohort) {
      for (const [userId, value] of inCohort) {
        yield [{ userId, cohortId }, value];
      }
    }
  }

  *keys(): IterableIterator<Seat> {
    for (const [seat] of this.entries()) yield seat;
  }

  *values(): IterableIterator<T> {
    for (const inCohort of this.byCohort.values()) yield* inCohort.values();
  }

  [Symbol.iterator](): IterableIterator<[Seat, T]> {
    return this.entries();
  }
}

function put<T>(
  outer: Map<string, Map<string, T>>,
  first: string,
  second: string,
  value: T,
): void {
  let inner = outer.get(first);
  if (!inner) {
    inner = new Map();
    outer.set(first, inner);
  }
  inner.set(second, value);
}

function remove<T>(
  outer: Map<string, Map<string, T>>,
  first: string,
  second: string,
): void {
  const inner = outer.get(first);
  if (!inner) return;
  inner.delete(second);
  if (inner.size === 0) outer.delete(first);
}
