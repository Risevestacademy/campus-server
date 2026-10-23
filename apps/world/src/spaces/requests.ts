import {
  Direction,
  step,
  walkable,
  type Grid,
  type Tile,
} from '../movement/grid.js';
import { spaceAt, type SpaceIndex } from '../movement/spaces.js';
import { seatKey, type Seat } from '../seat.js';

/** How long after a no before the same person may ask the same space again. */
export const ASK_AGAIN_AFTER_MS = 30_000;

export interface EntryRequest extends Seat {
  spaceKey: string;
}

export type AskResult = 'asked' | 'already_asking' | 'too_soon';

/** Whether a step from `tile` would land on floor inside `spaceKey`. */
export function besideSpace(
  grid: Grid,
  spaces: SpaceIndex,
  tile: Tile,
  spaceKey: string,
): boolean {
  return Object.values(Direction).some((direction) => {
    const next = step(tile, direction);
    return walkable(grid, next) && spaceAt(spaces, next) === spaceKey;
  });
}

/**
 * Requests to enter, and the yeses not yet walked through, per cohort. In
 * this process like the locks: a request is only ever answered by somebody
 * standing inside, and a restart takes everybody out.
 */
export class EntryRequests {
  private readonly open = new Map<string, EntryRequest>();
  private readonly passes = new Map<string, string>();
  private readonly declinedAt = new Map<string, number>();

  ask(seat: Seat, spaceKey: string, now: number): AskResult {
    const key = seatKey(seat);
    if (this.open.has(key)) return 'already_asking';
    const declined = this.declinedAt.get(declineKey(seat, spaceKey));
    if (declined !== undefined && now - declined < ASK_AGAIN_AFTER_MS) {
      return 'too_soon';
    }
    this.open.set(key, {
      userId: seat.userId,
      cohortId: seat.cohortId,
      spaceKey,
    });
    return 'asked';
  }

  openFor(seat: Seat): EntryRequest | undefined {
    return this.open.get(seatKey(seat));
  }

  /** The request closed, or undefined when there was none. */
  close(seat: Seat): EntryRequest | undefined {
    const key = seatKey(seat);
    const request = this.open.get(key);
    this.open.delete(key);
    return request;
  }

  admit(seat: Seat): EntryRequest | undefined {
    const request = this.close(seat);
    if (request) this.passes.set(seatKey(seat), request.spaceKey);
    return request;
  }

  decline(seat: Seat, now: number): EntryRequest | undefined {
    const request = this.close(seat);
    if (!request) return undefined;
    for (const [key, at] of this.declinedAt) {
      if (now - at >= ASK_AGAIN_AFTER_MS) this.declinedAt.delete(key);
    }
    this.declinedAt.set(declineKey(seat, request.spaceKey), now);
    return request;
  }

  /** The space a yes lets them into on their next step, if any. */
  passFor(seat: Seat): string | undefined {
    return this.passes.get(seatKey(seat));
  }

  dropPass(seat: Seat): void {
    this.passes.delete(seatKey(seat));
  }

  /** Open requests, all of them or those to one cohort's copy of a space. A copy. */
  all(cohortId?: string, spaceKey?: string): EntryRequest[] {
    return [...this.open.values()].filter(
      (request) =>
        (cohortId === undefined || request.cohortId === cohortId) &&
        (spaceKey === undefined || request.spaceKey === spaceKey),
    );
  }
}

function declineKey(seat: Seat, spaceKey: string): string {
  return `${seatKey(seat)}\u0000${spaceKey}`;
}
