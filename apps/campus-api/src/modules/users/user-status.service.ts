import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import type { UserStatusDto } from './dto/user-status.dto.js';
import { hasAdminPowers, UserStatus, users } from './schema.js';
import {
  AccountStatusLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

/**
 * Suspending an account and putting it back. Admin tooling like
 * UserRolesService, and shaped after it: one transaction, both rows locked
 * in id order, the caller's role read again under the lock, and an audit
 * entry that commits with the change.
 */
@Injectable()
export class UserStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionIssuer,
  ) {}

  /**
   * Takes an account out of service. It cannot sign in from the next
   * request — the sign-in gate and SessionGuard both read `status` — and
   * the sessions it holds end now rather than when their tokens lapse, so
   * `world` drops an open socket on its next heartbeat too, twice over: the
   * account is suspended, and the epoch the socket named no longer matches.
   *
   * Two refusals, both 409 rather than 403, which on these routes means
   * "you are not an admin" — the caller is one, and it is the state of
   * things that refuses them:
   *
   * - **Themselves.** An admin suspending their own account by a slip is
   *   locked out with nobody having decided it. Somebody else does it.
   * - **An account already suspended.** Nothing to do, and nothing to
   *   record twice.
   *
   * Suspension is the account's status alone: it keeps its cohorts and its
   * role, and lasts until an admin reinstates it. The reason, if one was
   * given, is recorded in the audit entry and nowhere else.
   */
  async suspend(
    actor: AuthenticatedUser,
    targetId: string,
    reason?: string,
    correlationId?: string,
  ): Promise<UserStatusDto> {
    if (actor.id === targetId) {
      throw new AccountStatusLockedException(
        'You cannot suspend your own account: ask another admin',
        { userId: targetId },
      );
    }
    return this.change(
      actor,
      targetId,
      UserStatus.Suspended,
      reason,
      correlationId,
    );
  }

  /**
   * Puts a suspended account back to active. It can sign in again from the
   * next request, but its sessions are *not* restored: the epoch it was
   * suspended on stays where it is, so the person signs in again rather than
   * walking back in with tokens issued before the suspension. Only an
   * account that is suspended may be reinstated; one that is not is a 409,
   * the same refusal the other way round.
   */
  async reinstate(
    actor: AuthenticatedUser,
    targetId: string,
    correlationId?: string,
  ): Promise<UserStatusDto> {
    return this.change(
      actor,
      targetId,
      UserStatus.Active,
      undefined,
      correlationId,
    );
  }

  /**
   * The one transaction both routes share. The rows are locked in id order,
   * as UserRolesService locks them, so two admins acting on each other queue
   * for the same first lock instead of each holding one and waiting for the
   * other.
   */
  private async change(
    actor: AuthenticatedUser,
    targetId: string,
    status: UserStatus,
    reason: string | undefined,
    correlationId?: string,
  ): Promise<UserStatusDto> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: users.id,
          email: users.email,
          systemRole: users.systemRole,
          status: users.status,
        })
        .from(users)
        .where(inArray(users.id, [actor.id, targetId]))
        .orderBy(asc(users.id))
        .for('update');
      const caller = locked.find((row) => row.id === actor.id);
      const target = locked.find((row) => row.id === targetId);

      // The guard read the caller's role before this began, which is too
      // early to stop a caller who has been demoted since. The row decides.
      if (!caller || !hasAdminPowers(caller.systemRole)) {
        throw new AccessDeniedException('Admin role required');
      }
      if (!target) {
        throw new UserNotFoundException(`User ${targetId} not found`, {
          userId: targetId,
        });
      }
      if (target.status === status) {
        throw new AccountStatusLockedException(
          status === UserStatus.Suspended
            ? 'This account is already suspended'
            : 'This account is not suspended',
          { userId: targetId },
        );
      }

      const [row] = await tx
        .update(users)
        .set({ status })
        .where(eq(users.id, targetId))
        .returning({
          id: users.id,
          email: users.email,
          status: users.status,
        });

      if (status === UserStatus.Suspended) {
        await writeAuditEntry(tx, {
          actorUserId: actor.id,
          correlationId,
          action: AuditAction.UserSuspended,
          subject: { type: AuditSubjectType.User, id: targetId },
          details: { reason: reason ?? null },
        });
        // In this transaction, so the suspension and the sessions go
        // together: neither may commit without the other.
        await this.sessions.revokeAllSessions(targetId, new Date(), tx);
      } else {
        await writeAuditEntry(tx, {
          actorUserId: actor.id,
          correlationId,
          action: AuditAction.UserReinstated,
          subject: { type: AuditSubjectType.User, id: targetId },
          details: {},
        });
      }
      return row;
    });
  }
}
