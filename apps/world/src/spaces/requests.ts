import { SPACE_ACCESS } from '@campus/space-access';

import type { WorldSpace } from '../infra/accounts.js';
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

/**
 * A request to enter, with the socket that asked and every socket it was
 * sent to, so ending it reaches exactly those.
 */
export interface EntryRequest<T> extends Seat {
  spaceKey: string;
  asker: T;
  told: Set<T>;
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

/** Whether asking is a way in: a set-up, standing space that is designated, or normal and locked. */
export function takesRequests(
  space: WorldSpace | undefined,
  locked: boolean,
): boolean {
  if (!space || space.retiredAt !== null || space.kind === null) return false;
  return (
    space.access === SPACE_ACCESS.Designated ||
    (space.access === SPACE_ACCESS.Normal && locked)
  );
}

export interface RequestFacts {
  /** The door would let them in without asking. */
  mayWalkIn: boolean;
  takesRequests: boolean;
  beside: boolean;
  /** How many people inside may answer. */
  answerers: number;
}

export type Obstacle =
  'may_walk_in' | 'no_requests' | 'not_beside' | 'nobody_inside';

/**
 * Why a request to enter cannot stand, or null when it can: the one rule
 * for asking, for keeping a request open, and, but for nobody inside, for
 * keeping a yes.
 */
export function obstacle(facts: RequestFacts): Obstacle | null {
  if (facts.mayWalkIn) return 'may_walk_in';
  if (!facts.takesRequests) return 'no_requests';
  if (!facts.beside) return 'not_beside';
  if (facts.answerers === 0) return 'nobody_inside';
  return null;
}

/**
 * Requests to enter, and the yeses not yet walked through, per cohort. In
 * this process like the locks: a request is only ever answered by somebody
 * standing inside, and a restart takes everybody out.
 */
export class EntryRequests<T> {
  private readonly open = new Map<string, EntryRequest<T>>();
  private readonly passes = new Map<string, Seat & { spaceKey: string }>();
  private readonly declinedAt = new Map<string, number>();

  ask(seat: Seat, spaceKey: string, now: number, asker: T): AskResult {
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
      asker,
      told: new Set(),
    });
    return 'asked';
  }

  openFor(seat: Seat): EntryRequest<T> | undefined {
    return this.open.get(seatKey(seat));
  }

  close(seat: Seat): EntryRequest<T> | undefined {
    const key = seatKey(seat);
    const request = this.open.get(key);
    this.open.delete(key);
    return request;
  }

  admit(seat: Seat): EntryRequest<T> | undefined {
    const request = this.close(seat);
    if (request) {
      this.passes.set(seatKey(seat), {
        userId: seat.userId,
        cohortId: seat.cohortId,
        spaceKey: request.spaceKey,
      });
    }
    return request;
  }

  decline(seat: Seat, now: number): EntryRequest<T> | undefined {
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
    return this.passes.get(seatKey(seat))?.spaceKey;
  }

  dropPass(seat: Seat): void {
    this.passes.delete(seatKey(seat));
  }

  /** Open requests, all of them or those to one cohort's copy of a space. */
  all(cohortId?: string, spaceKey?: string): EntryRequest<T>[] {
    return [...this.open.values()].filter((request) =>
      matches(request, cohortId, spaceKey),
    );
  }

  /** Yeses not yet walked through, all of them or those into one cohort's copy of a space. */
  allPasses(
    cohortId?: string,
    spaceKey?: string,
  ): (Seat & { spaceKey: string })[] {
    return [...this.passes.values()].filter((pass) =>
      matches(pass, cohortId, spaceKey),
    );
  }
}

function matches(
  entry: { cohortId: string; spaceKey: string },
  cohortId?: string,
  spaceKey?: string,
): boolean {
  return (
    (cohortId === undefined || entry.cohortId === cohortId) &&
    (spaceKey === undefined || entry.spaceKey === spaceKey)
  );
}

function declineKey(seat: Seat, spaceKey: string): string {
  return `${seatKey(seat)}\u0000${spaceKey}`;
}
