import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import type { UserSystemRoleDto } from './dto/system-role.dto.js';
import { hasAdminPowers, SystemRole, users } from './schema.js';
import {
  SystemRoleLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

/**
 * Granting and revoking the admin role. Apart from UsersService, which the
 * session layer depends on; this is admin tooling and nothing else imports
 * it.
 */
@Injectable()
export class UserRolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionIssuer,
  ) {}

  /**
   * Makes somebody an admin, or an ordinary user again.
   *
   * Any admin may do either, to anybody but two people:
   *
   * - A super admin. Their role is not the API's to change, in either
   *   direction: that is what makes them the accounts that can always make
   *   and unmake the others.
   * - Themselves. An admin revoking their own role by a slip is locked out
   *   with nobody having decided it, and granting yourself a role you hold
   *   means nothing. Somebody else does it.
   *
   * A grant takes effect on the target's next request with nothing to
   * revoke: the session guard reads the role from the row every time, never
   * from the token. A revocation ends their sessions as well. The admin
   * routes would refuse them anyway, but an admin needs no cohort to hold a
   * session, so without that one who has none would keep a working token,
   * and a place in the world, until it ran out.
   *
   * The caller's role is read again under the same lock as the target's.
   * The guard checked it before this began, which is too early to stop two
   * admins revoking each other at once, or one who has just been revoked
   * finishing a change already under way.
   *
   * Setting the role somebody already has changes nothing and records
   * nothing.
   */
  async setSystemRole(
    actor: AuthenticatedUser,
    targetId: string,
    role: SystemRole.User | SystemRole.Admin,
    correlationId?: string,
  ): Promise<UserSystemRoleDto> {
    if (actor.id === targetId) {
      throw new SystemRoleLockedException(
        'You cannot change your own role: ask another admin',
        { userId: targetId },
      );
    }

    // One transaction: the rows are read under a lock so the entry records
    // the role that was replaced, and the change never commits without it.
    return this.db.transaction(async (tx) => {
      // Both rows, always in id order: two admins changing each other then
      // queue for the same first lock instead of each holding one and
      // waiting for the other.
      const locked = await tx
        .select({
          id: users.id,
          email: users.email,
          systemRole: users.systemRole,
        })
        .from(users)
        .where(inArray(users.id, [actor.id, targetId]))
        .orderBy(asc(users.id))
        .for('update');
      const caller = locked.find((row) => row.id === actor.id);
      const target = locked.find((row) => row.id === targetId);

      if (!caller || !hasAdminPowers(caller.systemRole)) {
        throw new AccessDeniedException('Admin role required');
      }
      if (!target) {
        throw new UserNotFoundException(`User ${targetId} not found`, {
          userId: targetId,
        });
      }
      if (target.systemRole === SystemRole.SuperAdmin) {
        throw new SystemRoleLockedException(
          "A super admin's role cannot be changed",
          { userId: targetId },
        );
      }
      if (target.systemRole === role) {
        return target;
      }

      const [row] = await tx
        .update(users)
        .set({ systemRole: role })
        .where(eq(users.id, targetId))
        .returning({
          id: users.id,
          email: users.email,
          systemRole: users.systemRole,
        });

      await writeAuditEntry(tx, {
        actorUserId: actor.id,
        correlationId,
        action: AuditAction.SystemRoleChanged,
        subject: { type: AuditSubjectType.User, id: targetId },
        details: { from: target.systemRole, to: role, source: 'admin' },
      });
      if (role === SystemRole.User) {
        // In this transaction, so the role and the sessions go together.
        await this.sessions.revokeAllSessions(targetId, new Date(), tx);
      }
      return row;
    });
  }
}
