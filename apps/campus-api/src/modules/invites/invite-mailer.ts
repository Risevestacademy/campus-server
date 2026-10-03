import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  EMAIL_SENDER,
  type EmailSender,
} from '../../infra/email/email-sender.js';
import { InviteEmailStatus } from './dto/invite-response.dto.js';
import { renderInviteEmail } from './invite-email.js';
import { InvitesService } from './invites.service.js';

/**
 * Emails a freshly created invite to its invitee.
 *
 * Runs after the invite is written and never undoes it: the admin already
 * holds the link, so a failed send is reported in the create response —
 * share the link by hand — rather than failing a request that succeeded.
 */
@Injectable()
export class InviteMailer {
  constructor(
    private readonly invites: InvitesService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InviteMailer.name);
  }

  async send(
    invite: {
      id: string;
      token: string;
      inviteLink: string;
    },
    idempotencyKey?: string,
  ): Promise<InviteEmailStatus> {
    if (!this.sender.enabled) {
      return InviteEmailStatus.Disabled;
    }

    try {
      // The same read the invitation screen makes, so the email and the page
      // it links to cannot disagree about the offer.
      const details = await this.invites.previewByToken(invite.token);
      const rendered = renderInviteEmail(details, invite.inviteLink);
      const result = await this.sender.send({
        to: details.email,
        ...rendered,
        // A retried create is a new invite with a new id, so this only
        // guards the send itself against being repeated.
        // For resend, we pass a key derived from the new token hash so each
        // resend gets its own key and isn't dropped by Resend.
        idempotencyKey: idempotencyKey ?? `invite/${invite.id}`,
      });

      // Neither line carries the link, which opens the invite's preview, and
      // logs outlive it. `reason` is Resend's own message, so it may name
      // the recipient when the address itself is what was refused.
      if (result.ok) {
        this.logger.info(
          { inviteId: invite.id, emailId: result.id },
          'invite email sent',
        );
        return InviteEmailStatus.Sent;
      }
      this.logger.warn(
        { inviteId: invite.id, reason: result.reason },
        'invite email not sent',
      );
      return InviteEmailStatus.Failed;
    } catch (err) {
      this.logger.error(
        { inviteId: invite.id, err },
        'invite email could not be prepared',
      );
      return InviteEmailStatus.Failed;
    }
  }
}
