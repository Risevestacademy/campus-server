import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import {
  EMAIL_SENDER,
  type EmailSender,
} from '../../infra/email/email-sender.js';
import {
  adminReviewUrl,
  renderFeedbackReportEmail,
} from './feedback-report-email.js';
import { FeedbackService } from './feedback.service.js';
import { FeedbackType } from './schema.js';

/** What the notifier needs of a piece of feedback just saved. */
export interface SavedFeedback {
  id: string;
  type: FeedbackType;
  /** The account a report names, who is the one admin not to tell. */
  reportedUserId?: string;
  /** The cohort it was sent from, which decides where the email links. */
  cohortId?: string;
}

/**
 * Emails the admins that a report has arrived.
 *
 * Runs after the report is saved and never undoes it: the report is in the
 * list, where every admin can see it, so a failed send costs the nudge and
 * not the report. That is also why this returns nothing, and why the route
 * does not wait for it.
 *
 * Reports only. A bug or an idea waits in the list until somebody looks.
 */
@Injectable()
export class FeedbackNotifier {
  constructor(
    private readonly feedback: FeedbackService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FeedbackNotifier.name);
  }

  async notify(saved: SavedFeedback): Promise<void> {
    if (saved.type !== FeedbackType.Report || !this.sender.enabled) {
      return;
    }

    try {
      const recipients = await this.feedback.reportRecipients(
        saved.reportedUserId,
      );
      const email = renderFeedbackReportEmail(
        adminReviewUrl(this.config.APP_PUBLIC_URL, saved.cohortId),
      );
      // One email each, so no admin sees who else was told, and one bad
      // address does not cost the others theirs. One at a time, so a long
      // list of admins is not a burst the provider refuses part of.
      let failed = 0;
      for (const to of recipients) {
        const result = await this.sender.send({
          to,
          ...email,
          idempotencyKey: `feedback-report/${saved.id}/${to}`,
        });
        if (!result.ok) failed += 1;
      }
      // Counts, never addresses or anything of the report: logs outlive both.
      this.logger[failed > 0 ? 'warn' : 'info'](
        { feedbackId: saved.id, sent: recipients.length - failed, failed },
        'report email sent to admins',
      );
    } catch (err) {
      this.logger.error(
        { feedbackId: saved.id, err },
        'report email could not be prepared',
      );
    }
  }
}
