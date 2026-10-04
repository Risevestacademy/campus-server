import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import type { UserSystemRoleDto } from './dto/system-role.dto.js';
import { SystemRole, users } from './schema.js';
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
   * Takes effect on the target's next request, with nothing to revoke: the
   * session guard reads the role from the row every time, never from the
   * token.
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

    // One transaction: the row is read under a lock so the entry records the
    // role that was replaced, and the change never commits without it.
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: users.id,
          email: users.email,
          systemRole: users.systemRole,
        })
        .from(users)
        .where(eq(users.id, targetId))
        .for('update');

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
      return row;
    });
  }
}
