import { asc, inArray } from 'drizzle-orm';

import type { Db } from '../../infra/database/database.constants.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { hasAdminPowers, UserStatus, users } from './schema.js';
import { UserNotFoundException } from './users.exceptions.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Locks an admin and the account they act on, in id order, so two admins
 * acting on each other queue for the same first lock. The caller's role and
 * status are read again under the lock: the guard read them too early to
 * stop one demoted or suspended since.
 */
export async function lockAdminAndTarget(
  tx: Tx,
  actorId: string,
  targetId: string,
) {
  const locked = await tx
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      systemRole: users.systemRole,
      status: users.status,
      suspendedBy: users.suspendedBy,
      suspendedByRole: users.suspendedByRole,
    })
    .from(users)
    .where(inArray(users.id, [actorId, targetId]))
    .orderBy(asc(users.id))
    .for('update');
  const caller = locked.find((row) => row.id === actorId);
  const target = locked.find((row) => row.id === targetId);

  if (!caller || !hasAdminPowers(caller.systemRole)) {
    throw new AccessDeniedException('Admin role required');
  }
  if (caller.status !== UserStatus.Active) {
    throw new AccessDeniedException('Your account is not active');
  }
  if (!target) {
    throw new UserNotFoundException(`User ${targetId} not found`, {
      userId: targetId,
    });
  }
  return { caller, target };
}
