import type { PinoLogger } from 'nestjs-pino';

import type { EmailSender } from '../../infra/email/email-sender.js';
import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import { InviteEmailStatus } from './dto/invite-response.dto.js';
import { InviteMailer } from './invite-mailer.js';
import type { InvitesService } from './invites.service.js';

const INVITE = {
  id: 'invite-1',
  token: 'raw-token',
  inviteLink: 'https://dev.campusbyrise.com/invitation?token=raw-token',
};

const PREVIEW = {
  email: 'ada@campus.local',
  cohort: { name: 'PD 2026', code: 'PD26', startDate: null, endDate: null },
  track: null,
  cohortRole: CohortRole.Mentor,
  systemRole: SystemRole.User,
  invitedBy: { firstName: 'Jerry', lastName: null },
  expiresAt: new Date('2026-10-07T12:00:00.000Z'),
  guestAccessExpiresAt: null,
};

function mailer(sender: EmailSender, previewByToken = vi.fn()) {
  const logger = {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const invites = { previewByToken } as unknown as InvitesService;
  return {
    logger,
    previewByToken,
    subject: new InviteMailer(invites, sender, logger as unknown as PinoLogger),
  };
}

describe('InviteMailer', () => {
  it('does no work at all while email is disabled', async () => {
    const send = vi.fn();
    const { subject, previewByToken } = mailer({ enabled: false, send });

    await expect(subject.send(INVITE)).resolves.toBe(
      InviteEmailStatus.Disabled,
    );
    expect(previewByToken).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to the invited address with a key tied to the invite', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'em_1' });
    const { subject, previewByToken } = mailer(
      { enabled: true, send },
      vi.fn().mockResolvedValue(PREVIEW),
    );

    await expect(subject.send(INVITE)).resolves.toBe(InviteEmailStatus.Sent);
    expect(previewByToken).toHaveBeenCalledWith('raw-token');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@campus.local',
        idempotencyKey: 'invite/invite-1',
      }),
    );
  });

  // The invite was written a moment ago, so this is a fault — but the
  // invite still stands, and the admin still has the link.
  it('reports failed, and logs, when the invite cannot be read back', async () => {
    const send = vi.fn();
    const { subject, logger } = mailer(
      { enabled: true, send },
      vi.fn().mockRejectedValue(new Error('db down')),
    );

    await expect(subject.send(INVITE)).resolves.toBe(InviteEmailStatus.Failed);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('never logs the link', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'refused' });
    const { subject, logger } = mailer(
      { enabled: true, send },
      vi.fn().mockResolvedValue(PREVIEW),
    );

    await subject.send(INVITE);

    const logged = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain('raw-token');
    expect(logged).toContain('refused');
  });
});
