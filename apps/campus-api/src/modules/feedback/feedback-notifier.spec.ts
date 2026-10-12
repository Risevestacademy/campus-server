import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../infra/config/env.js';
import type { EmailSender } from '../../infra/email/email-sender.js';
import { FeedbackNotifier } from './feedback-notifier.js';
import { renderFeedbackReportEmail } from './feedback-report-email.js';
import type { FeedbackService } from './feedback.service.js';
import { FeedbackType } from './schema.js';

const APP = 'https://campus.example.com';

function notifier(sender: EmailSender, reportRecipients = vi.fn()) {
  const logger = {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    logger,
    reportRecipients,
    subject: new FeedbackNotifier(
      { reportRecipients } as unknown as FeedbackService,
      sender,
      { APP_PUBLIC_URL: APP } as Env,
      logger as unknown as PinoLogger,
    ),
  };
}

const REPORT = { id: 'feedback-1', type: FeedbackType.Report };

describe('FeedbackNotifier', () => {
  it('does no work at all while email is disabled', async () => {
    const send = vi.fn();
    const { subject, reportRecipients } = notifier({ enabled: false, send });

    await subject.notify(REPORT);

    expect(reportRecipients).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  /** A bug or an idea waits in the list; only a report is worth an email. */
  it.each([FeedbackType.Bug, FeedbackType.Idea])(
    'does no work at all for a %s',
    async (type) => {
      const send = vi.fn();
      const { subject, reportRecipients } = notifier({ enabled: true, send });

      await subject.notify({ id: 'feedback-1', type });

      expect(reportRecipients).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('emails each admin on their own, once', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'email-1' });
    const { subject, logger } = notifier(
      { enabled: true, send },
      vi.fn().mockResolvedValue(['root@campus.local', 'admin@campus.local']),
    );

    await subject.notify(REPORT);

    expect(send.mock.calls.map(([email]) => email.to)).toEqual([
      'root@campus.local',
      'admin@campus.local',
    ]);
    // One key per report and per admin, so a retry reaches nobody twice.
    expect(send.mock.calls.map(([email]) => email.idempotencyKey)).toEqual([
      'feedback-report/feedback-1/root@campus.local',
      'feedback-report/feedback-1/admin@campus.local',
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { feedbackId: 'feedback-1', sent: 2, failed: 0 },
      'report email sent to admins',
    );
  });

  /** The admin a report is about is the one admin not to tell. */
  it('asks for the admins other than the one the report names', async () => {
    const { subject, reportRecipients } = notifier(
      { enabled: true, send: vi.fn() },
      vi.fn().mockResolvedValue([]),
    );

    await subject.notify({ ...REPORT, reportedUserId: 'admin-1' });

    expect(reportRecipients).toHaveBeenCalledWith('admin-1');
  });

  /**
   * A long list of admins sent all at once is a burst a mail provider
   * refuses part of. Each send waits for the one before it.
   */
  it('sends one at a time, never two at once', async () => {
    let inFlight = 0;
    let most = 0;
    const send = vi.fn(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true as const, id: 'email' };
    });
    const { subject } = notifier(
      { enabled: true, send },
      vi.fn().mockResolvedValue(['a@x.local', 'b@x.local', 'c@x.local']),
    );

    await subject.notify(REPORT);

    expect(send).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it('says how many did not go, and still sends the rest', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'bounced' })
      .mockResolvedValueOnce({ ok: true, id: 'email-2' });
    const { subject, logger } = notifier(
      { enabled: true, send },
      vi.fn().mockResolvedValue(['root@campus.local', 'admin@campus.local']),
    );

    await subject.notify(REPORT);

    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { feedbackId: 'feedback-1', sent: 1, failed: 1 },
      'report email sent to admins',
    );
  });

  /**
   * The route does not wait for this, so a rejection would have nowhere to
   * go. The report is saved either way; a send that cannot start costs the
   * nudge.
   */
  it('never throws, whatever goes wrong', async () => {
    const { subject, logger } = notifier(
      { enabled: true, send: vi.fn() },
      vi.fn().mockRejectedValue(new Error('database unavailable')),
    );

    await expect(subject.notify(REPORT)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('the report email', () => {
  /**
   * A report is one member's account of another. The email says there is
   * one and where to read it, and has no way to say more: it is not given
   * the report.
   */
  it('says a report is waiting, links to the app, and is told nothing else', () => {
    const email = renderFeedbackReportEmail(APP);

    expect(email.subject).toBe('A member has sent a report');
    expect(email.text).toContain(APP);
    expect(email.html).toContain(`href="${APP}"`);
    expect(renderFeedbackReportEmail).toHaveLength(1);
  });

  it('escapes the address it links to', () => {
    const email = renderFeedbackReportEmail('https://x.example/?a=1&b="2"');

    expect(email.html).toContain(
      'href="https://x.example/?a=1&amp;b=&quot;2&quot;"',
    );
  });
});
