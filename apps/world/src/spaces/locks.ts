import { DEFAULT_SPACE_KEY } from '@campus/session';
import { SPACE_ACCESS } from '@campus/space-access';

import type { WorldSpace } from '../infra/accounts.js';

const NOTICE_BOARD = 'notice_board';

/**
 * Whether the people inside may lock a space: a normal one, set up and
 * standing, that hears as one room. Never a proximity space, the notice
 * board, the corridors, or a drawn space the database has no row for yet.
 * Who is asking does not matter: anybody inside may, guests included.
 */
export function isLockable(spaceKey: string, space: WorldSpace): boolean {
  return (
    spaceKey !== DEFAULT_SPACE_KEY &&
    space.retiredAt === null &&
    space.kind !== null &&
    space.kind !== NOTICE_BOARD &&
    space.access === SPACE_ACCESS.Normal &&
    space.audioMode !== 'proximity'
  );
}

/** Every lockable space among these, by key, sorted. */
export function lockableKeys(
  spaces: ReadonlyMap<string, WorldSpace>,
): string[] {
  return [...spaces]
    .filter(([key, space]) => isLockable(key, space))
    .map(([key]) => key)
    .sort();
}

/**
 * Which spaces are locked, per cohort. Kept in this process: a lock ends
 * when the last person leaves, and a restart takes everybody out, so there
 * is nothing worth keeping across one. A second instance needs them shared,
 * with the rest of the fan-out between instances.
 */
export class SpaceLocks {
  private readonly byCohort = new Map<string, Set<string>>();

  isLocked(cohortId: string, spaceKey: string): boolean {
    return this.byCohort.get(cohortId)?.has(spaceKey) ?? false;
  }

  /** False when it was locked already. */
  lock(cohortId: string, spaceKey: string): boolean {
    const locked = this.byCohort.get(cohortId);
    if (!locked) {
      this.byCohort.set(cohortId, new Set([spaceKey]));
      return true;
    }
    if (locked.has(spaceKey)) return false;
    locked.add(spaceKey);
    return true;
  }

  /** False when it was not locked. */
  unlock(cohortId: string, spaceKey: string): boolean {
    const locked = this.byCohort.get(cohortId);
    if (!locked?.delete(spaceKey)) return false;
    if (locked.size === 0) this.byCohort.delete(cohortId);
    return true;
  }

  /** The spaces locked in one cohort's campus, sorted. */
  in(cohortId: string): string[] {
    return [...(this.byCohort.get(cohortId) ?? [])].sort();
  }

  /** Every lock, as cohort and space. A copy, so a caller may unlock as it goes. */
  all(): { cohortId: string; spaceKey: string }[] {
    return [...this.byCohort].flatMap(([cohortId, keys]) =>
      [...keys].map((spaceKey) => ({ cohortId, spaceKey })),
    );
  }
}
