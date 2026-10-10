import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import type { UserStatusDto } from './dto/user-status.dto.js';
import { hasAdminPowers, SystemRole, UserStatus, users } from './schema.js';
import {
  AccountStatusLockedException,
  UserNotFoundException,
} from './users.exceptions.js';

/**
 * Suspending an account and putting it back. Admin tooling like
 * UserRolesService, and shaped after it: one transaction, both rows locked
 * in id order, the caller's role read again under the lock, and an audit
 * entry that commits with the change.
 *
 * Who may do it to whom, which is what the lock is for — the rank of both
 * sides is read under it, so it cannot go stale mid-decision:
 *
 * - A super admin may suspend anybody but themselves, and reinstate
 *   anybody.
 * - A plain admin may suspend anybody but themselves *and* super admins.
 * - A plain admin may reinstate only an account a plain admin suspended,
 *   so a suspension a super admin made is lifted only by a super admin.
 *
 * The two rank refusals are 403, the state refusals 409.
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
   * The refusals, and which status each one takes:
   *
   * - **Themselves** (409). An admin suspending their own account by a slip
   *   is locked out with nobody having decided it. Somebody else does it.
   * - **An account already suspended** (409). Nothing to do, and nothing to
   *   record twice.
   * - **A super admin, by a plain admin** (403). Otherwise one admin account
   *   could lock out every super admin and recovery would need the
   *   database. A super admin may suspend anybody but themselves, so a
   *   compromised root account can still be taken out.
   * - **A caller who is no longer active** (403). Suspended between the
   *   guard reading them and this transaction locking them; the guard would
   *   have refused the next request anyway.
   *
   * Suspension is the account's status alone: it keeps its cohorts and its
   * role, and lasts until an admin reinstates it. The row also records who
   * suspended it and the role they held then, because reinstate decides on
   * that. The reason, if one was given, is recorded in the audit entry and
   * nowhere else.
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
   * walking back in with tokens issued before the suspension.
   *
   * Only an account that is suspended may be reinstated; one that is not is
   * a 409, the same refusal the other way round. And a plain admin may lift
   * only a suspension a plain admin made: one a super admin made is a 403,
   * as is a caller who is no longer active. Reinstating clears who suspended
   * the account, and the audit entry keeps who it was.
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
   * other. Everything decided here is decided under that lock: the caller's
   * role and status, the target's, and who suspended it.
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
          suspendedBy: users.suspendedBy,
          suspendedByRole: users.suspendedByRole,
        })
        .from(users)
        .where(inArray(users.id, [actor.id, targetId]))
        .orderBy(asc(users.id))
        .for('update');
      const caller = locked.find((row) => row.id === actor.id);
      const target = locked.find((row) => row.id === targetId);

      // The guard read the caller before this began, which is too early to
      // stop a caller who has been demoted — or suspended — since. The row
      // decides, under the lock.
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

      // The state of the target first: it answers the request even when the
      // caller is also of the wrong rank, so "not suspended" never comes
      // back as "a super admin is required".
      if (target.status === status) {
        throw new AccountStatusLockedException(
          status === UserStatus.Suspended
            ? 'This account is already suspended'
            : 'This account is not suspended',
          { userId: targetId },
        );
      }

      // Then the rank of both sides.
      if (status === UserStatus.Suspended) {
        if (
          target.systemRole === SystemRole.SuperAdmin &&
          caller.systemRole !== SystemRole.SuperAdmin
        ) {
          throw new AccessDeniedException(
            'A super admin is required to suspend a super admin',
          );
        }
      } else if (
        caller.systemRole !== SystemRole.SuperAdmin &&
        target.suspendedByRole !== SystemRole.Admin
      ) {
        // A plain admin lifts what a plain admin suspended, whatever rank
        // that admin holds now — the role was stored as it was at the time.
        // A suspension with no recorded role is one no plain admin may lift.
        throw new AccessDeniedException(
          'A super admin is required to lift this suspension',
        );
      }

      const [row] = await tx
        .update(users)
        .set(
          status === UserStatus.Suspended
            ? {
                status,
                suspendedBy: actor.id,
                suspendedByRole: caller.systemRole,
              }
            : { status, suspendedBy: null, suspendedByRole: null },
        )
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
          details: { reason: reason ?? null, actorRole: caller.systemRole },
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
          details: {
            actorRole: caller.systemRole,
            suspendedBy: target.suspendedBy,
            suspendedByRole: target.suspendedByRole,
          },
        });
      }
      return row;
    });
  }
}
