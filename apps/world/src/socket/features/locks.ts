import { SpaceLocks, lockableKeys } from '../../spaces/locks.js';
import type { Connection } from '../connections.js';
import type { WorldContext } from '../context.js';
import { ServerErrorCode, encode } from '../protocol.js';
import type { Doors } from './doors.js';

type LocksContext = Pick<
  WorldContext,
  'connections' | 'send' | 'sendFrame' | 'broadcast' | 'isStopping'
>;

export type Locks = ReturnType<typeof createLocks>;

export function createLocks(
  ctx: LocksContext,
  doors: Pick<Doors, 'all'>,
  reviewRequests: (cohortId: string, spaceKey: string) => void,
) {
  const { connections, send, sendFrame, broadcast, isStopping } = ctx;
  const locks = new SpaceLocks();
  /** Which spaces may be locked, from the doors last read, sorted. */
  let lockable: readonly string[] = [];

  /**
   * After the spaces are read: tells everybody when the lockable spaces have
   * changed, and ends the locks on any that can no longer be locked.
   */
  function refreshLockable(): void {
    if (isStopping()) return;
    const next = lockableKeys(doors.all());
    if (
      next.length !== lockable.length ||
      next.some((key, i) => key !== lockable[i])
    ) {
      lockable = next;
      const frame = encode({ type: 'lockableSpaces', spaceKeys: next });
      for (const connection of connections.everyone()) {
        sendFrame(connection.socket, frame);
      }
    }
    for (const { cohortId, spaceKey } of locks.all()) {
      if (!lockable.includes(spaceKey)) unlock(cohortId, spaceKey, null);
    }
  }

  function setLock(connection: Connection, locked: boolean): void {
    const { cohortId, spaceKey, userId } = connection;
    if (!lockable.includes(spaceKey)) {
      send(connection.socket, {
        type: 'error',
        code: ServerErrorCode.NotAllowed,
        message: 'this space cannot be locked',
      });
      return;
    }
    if (!locked) {
      unlock(cohortId, spaceKey, userId);
    } else if (locks.lock(cohortId, spaceKey)) {
      broadcast(cohortId, { type: 'lockChanged', spaceKey, locked, userId });
    }
  }

  /** `userId` is who unlocked it, or null when the lock ended on its own. */
  function unlock(
    cohortId: string,
    spaceKey: string,
    userId: string | null,
  ): void {
    if (locks.unlock(cohortId, spaceKey)) {
      broadcast(cohortId, {
        type: 'lockChanged',
        spaceKey,
        locked: false,
        userId,
      });
      reviewRequests(cohortId, spaceKey);
    }
  }

  /** A lock ends when the last person in that cohort's copy of the space leaves. */
  function unlockIfEmpty(cohortId: string, spaceKey: string): void {
    if (
      locks.isLocked(cohortId, spaceKey) &&
      !connections
        .all()
        .some(
          (connection) =>
            connection.cohortId === cohortId &&
            connection.spaceKey === spaceKey,
        )
    ) {
      unlock(cohortId, spaceKey, null);
    }
  }

  return {
    refreshLockable,
    setLock,
    unlockIfEmpty,
    isLocked: (cohortId: string, spaceKey: string): boolean =>
      locks.isLocked(cohortId, spaceKey),
    lockedIn: (cohortId: string) => locks.in(cohortId),
    lockableSpaces: (): readonly string[] => lockable,
  };
}
