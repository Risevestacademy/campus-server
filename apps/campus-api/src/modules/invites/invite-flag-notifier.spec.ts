import type { PinoLogger } from 'nestjs-pino';

import type { EmailSender } from '../../infra/email/email-sender.js';
import { CohortRole } from '../cohorts/schema.js';
import { SystemRole } from '../users/schema.js';
import { InviteFlagNotifier } from './invite-flag-notifier.js';
import type { InvitesService } from './invites.service.js';

const NOTICE = {
  inviterEmail: 'admin@campus.local',
  inviteeEmail: 'ada@campus.local',
  cohortName: 'PD 2026',
  trackName: null,
  cohortRole: CohortRole.Mentor,
  systemRole: SystemRole.User,
  guestAccessExpiresAt: null,
  message: 'I am a professor, not a mentor.',
  flaggedAt: new Date('2026-10-03T12:00:00.000Z'),
};

function notifier(sender: EmailSender, getFlagNotice = vi.fn()) {
  const logger = {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const invites = { getFlagNotice } as unknown as InvitesService;
  return {
    logger,
    getFlagNotice,
    subject: new InviteFlagNotifier(
      invites,
      sender,
      logger as unknown as PinoLogger,
    ),
  };
}

describe('InviteFlagNotifier', () => {
  it('does no work at all while email is disabled', async () => {
    const send = vi.fn();
    const { subject, getFlagNotice } = notifier({ enabled: false, send });

    await subject.notify('invite-1');

    expect(getFlagNotice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to the admin who invited them, with a key tied to the invite', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'em_1' });
    const { subject } = notifier(
      { enabled: true, send },
      vi.fn().mockResolvedValue(NOTICE),
    );

    await subject.notify('invite-1');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@campus.local',
        idempotencyKey: 'invite-flag/invite-1',
      }),
    );
  });

  // The flag is already on the invite, so the request that raised it must
  // not fail because the nudge did.
  it('swallows a failure to read the flag back, and logs it', async () => {
    const send = vi.fn();
    const { subject, logger } = notifier(
      { enabled: true, send },
      vi.fn().mockRejectedValue(new Error('db down')),
    );

    await expect(subject.notify('invite-1')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('never logs what the invitee wrote', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'refused' });
    const { subject, logger } = notifier(
      { enabled: true, send },
      vi.fn().mockResolvedValue(NOTICE),
    );

    await subject.notify('invite-1');

    const logged = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(NOTICE.message);
    expect(logged).toContain('refused');
  });
});
