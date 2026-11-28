import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import {
  EMAIL_SENDER,
  type EmailSender,
} from '../../infra/email/email-sender.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AccessDeniedException } from '../../shared/exceptions/index.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { SessionIssuer } from '../auth/session-issuer.js';
import { googleCalendarGrants } from '../calendar/schema.js';
import { callChatAttachments } from '../calls/schema.js';
import { cohortMembers } from '../cohorts/schema.js';
import { endDeskClaims } from '../desks/end-claims.js';
import { DeskReleaseReason, deskClaims } from '../desks/schema.js';
import { feedbackAttachments } from '../feedback/schema.js';
import { InviteStatus, invites } from '../invites/schema.js';
import { spaceMemberships } from '../maps/schema.js';
import { MediaService } from '../media/media.service.js';
import { MediaStatus, media } from '../media/schema.js';
import {
  mentorshipGroupStudents,
  mentorshipGroups,
} from '../mentorship-groups/schema.js';
import { noticeAttachments } from '../notices/schema.js';
import { notifications } from '../notifications/schema.js';
import { roomLinkPasses } from '../room-links/schema.js';
import { renderAccountDeletedEmail } from './account-deleted-email.js';
import { lockAdminAndTarget } from './lock-admin-target.js';
import {
  DELETED_DISPLAY_NAME,
  deletedEmailOf,
  SystemRole,
  UserStatus,
  users,
} from './schema.js';
import { AccountStatusLockedException } from './users.exceptions.js';

/**
 * Deletes an account on the person's request. The row stays, because the
 * audit log points at it, but everything that says who they were goes, and
 * it can never sign in again. Final: there is no undo.
 *
 * Who may delete whom follows suspend: anybody but yourself, and a super
 * admin only by a super admin.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionIssuer,
    private readonly media: MediaService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountDeletionService.name);
  }

  async delete(
    actor: AuthenticatedUser,
    targetId: string,
    correlationId?: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (actor.id === targetId) {
      throw new AccountStatusLockedException(
        'You cannot delete your own account: ask another admin',
        { userId: targetId },
      );
    }

    const former = await this.db.transaction(async (tx) => {
      const { caller, target } = await lockAdminAndTarget(
        tx,
        actor.id,
        targetId,
      );
      if (target.status === UserStatus.Deleted) {
        throw new AccountStatusLockedException(
          'This account is already deleted',
          { userId: targetId },
        );
      }
      if (
        target.systemRole === SystemRole.SuperAdmin &&
        caller.systemRole !== SystemRole.SuperAdmin
      ) {
        throw new AccessDeniedException(
          'A super admin is required to delete a super admin',
        );
      }

      const memberships = await tx
        .select({ id: cohortMembers.id, leftAt: cohortMembers.leftAt })
        .from(cohortMembers)
        .where(eq(cohortMembers.userId, targetId))
        .for('update');
      const membershipIds = memberships.map((row) => row.id);

      if (membershipIds.length > 0) {
        const [led] = await tx
          .select({ id: mentorshipGroups.id })
          .from(mentorshipGroups)
          .where(inArray(mentorshipGroups.mentorMemberId, membershipIds))
          .limit(1);
        if (led) {
          throw new AccountStatusLockedException(
            'Reassign this mentor’s mentorship group before deleting their account',
            { userId: targetId, mentorshipGroupId: led.id },
          );
        }
      }

      const endedMembershipIds = memberships
        .filter((row) => row.leftAt === null)
        .map((row) => row.id);
      if (endedMembershipIds.length > 0) {
        await tx
          .update(cohortMembers)
          .set({ leftAt: now })
          .where(inArray(cohortMembers.id, endedMembershipIds));
      }
      if (membershipIds.length > 0) {
        await tx
          .update(cohortMembers)
          .set({ dismissalReason: null })
          .where(inArray(cohortMembers.id, membershipIds));
        await tx
          .delete(mentorshipGroupStudents)
          .where(
            inArray(mentorshipGroupStudents.cohortMemberId, membershipIds),
          );
      }
      await endDeskClaims(
        tx,
        eq(deskClaims.userId, targetId),
        DeskReleaseReason.AccountDeleted,
        now,
      );

      await tx
        .update(invites)
        .set({
          status: InviteStatus.Revoked,
          revokedAt: now,
          revokedBy: actor.id,
        })
        .where(
          and(
            eq(invites.email, target.email),
            eq(invites.status, InviteStatus.Pending),
          ),
        );
      await tx
        .update(invites)
        .set({
          email: deletedEmailOf(targetId),
          flaggedAt: null,
          flagMessage: null,
        })
        .where(eq(invites.email, target.email));
      await tx
        .delete(spaceMemberships)
        .where(eq(spaceMemberships.userId, targetId));
      await tx
        .delete(roomLinkPasses)
        .where(eq(roomLinkPasses.userId, targetId));
      await tx
        .delete(notifications)
        .where(eq(notifications.recipientId, targetId));
      await tx
        .update(googleCalendarGrants)
        .set({ revokeRequestedAt: now })
        .where(
          and(
            eq(googleCalendarGrants.userId, targetId),
            isNull(googleCalendarGrants.revokeRequestedAt),
          ),
        );

      const uploads = await tx
        .select({ id: media.id })
        .from(media)
        .where(
          and(
            eq(media.uploadedBy, targetId),
            eq(media.status, MediaStatus.Ready),
          ),
        );
      const uploadIds = uploads.map((row) => row.id);
      if (uploadIds.length > 0) {
        await tx
          .delete(noticeAttachments)
          .where(inArray(noticeAttachments.mediaId, uploadIds));
        await tx
          .delete(feedbackAttachments)
          .where(inArray(feedbackAttachments.mediaId, uploadIds));
        await tx
          .delete(callChatAttachments)
          .where(inArray(callChatAttachments.mediaId, uploadIds));
      }

      await tx
        .update(users)
        .set({
          status: UserStatus.Deleted,
          deletedAt: now,
          email: deletedEmailOf(targetId),
          providerId: null,
          firstName: null,
          lastName: null,
          displayName: DELETED_DISPLAY_NAME,
          phone: null,
          bio: null,
          googlePictureUrl: null,
          avatarMediaId: null,
          spriteKey: null,
          systemRole: SystemRole.User,
          suspendedBy: null,
          suspendedByRole: null,
          lastLoginAt: null,
          analyticsConsent: null,
          analyticsConsentAt: null,
        })
        .where(eq(users.id, targetId));

      await this.media.release(tx, uploadIds, now);
      await this.sessions.revokeAllSessions(targetId, now, tx);

      await writeAuditEntry(tx, {
        actorUserId: actor.id,
        correlationId,
        action: AuditAction.AccountDeleted,
        subject: { type: AuditSubjectType.User, id: targetId },
        details: {
          actorRole: caller.systemRole,
          systemRole: target.systemRole,
          endedMembershipIds,
        },
      });

      return { email: target.email, firstName: target.firstName };
    });

    await this.tellThem(targetId, former.email, former.firstName);
  }

  private async tellThem(
    userId: string,
    email: string,
    firstName: string | null,
  ): Promise<void> {
    if (!this.sender.enabled) return;
    try {
      const result = await this.sender.send({
        to: email,
        ...renderAccountDeletedEmail(firstName),
        idempotencyKey: `account-deleted/${userId}`,
      });
      if (!result.ok) {
        this.logger.warn(
          { userId, reason: result.reason },
          'account deletion email not sent',
        );
      }
    } catch (err) {
      this.logger.error({ userId, err }, 'account deletion email failed');
    }
  }
}
