import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  EMAIL_SENDER,
  type EmailSender,
} from '../../infra/email/email-sender.js';
import { renderInviteFlagEmail } from './invite-flag-email.js';
import { InvitesService } from './invites.service.js';

/**
 * Emails the admin who sent an invite that it has been flagged.
 *
 * Runs after the flag is written and never undoes it: the flag is on the
 * invite, where GET /v1/invites?flagged=true shows it to every admin, so a
 * failed send costs the nudge and not the report. That is also why this
 * returns nothing — the invitee has done their part either way.
 */
@Injectable()
export class InviteFlagNotifier {
  constructor(
    private readonly invites: InvitesService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InviteFlagNotifier.name);
  }

  async notify(inviteId: string): Promise<void> {
    if (!this.sender.enabled) {
      return;
    }

    try {
      const notice = await this.invites.getFlagNotice(inviteId);
      if (!notice) {
        this.logger.warn({ inviteId }, 'invite flag email had no flag to send');
        return;
      }
      const result = await this.sender.send({
        to: notice.inviterEmail,
        ...renderInviteFlagEmail(notice),
        // An invite takes one flag, so this only guards the send itself
        // against being repeated.
        idempotencyKey: `invite-flag/${inviteId}`,
      });

      // Neither line carries what the invitee wrote: it is theirs, and logs
      // outlive it.
      if (result.ok) {
        this.logger.info(
          { inviteId, emailId: result.id },
          'invite flag email sent',
        );
        return;
      }
      this.logger.warn(
        { inviteId, reason: result.reason },
        'invite flag email not sent',
      );
    } catch (err) {
      this.logger.error(
        { inviteId, err },
        'invite flag email could not be prepared',
      );
    }
  }
}
