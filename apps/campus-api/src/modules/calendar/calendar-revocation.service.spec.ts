import type { PinoLogger } from 'nestjs-pino';

import type { AccessTokenCache } from './access-token-cache.js';
import type {
  CalendarGrantsService,
  PendingRevocation,
} from './calendar-grants.service.js';
import type { CalendarChannelsService } from './calendar-channels.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import type { GoogleCalendarClient } from './google-calendar.client.js';

const grants = {
  requestRevocation: vi.fn(),
  requestLapsedRevocations: vi.fn(),
  pendingRevocations: vi.fn(),
  removeRevoked: vi.fn(),
  revocationFailed: vi.fn(),
};
const google = { revoke: vi.fn() };
const tokens = { evict: vi.fn(), clear: vi.fn() };
const channels = { stopAll: vi.fn() };
const logger = { error: vi.fn(), warn: vi.fn(), setContext: vi.fn() };

const revocations = () =>
  new CalendarRevocationService(
    grants as unknown as CalendarGrantsService,
    google as unknown as GoogleCalendarClient,
    tokens as unknown as AccessTokenCache,
    channels as unknown as CalendarChannelsService,
    logger as unknown as PinoLogger,
  );

const pending = (
  userId: string,
  refreshToken: string | null = `${userId}-refresh`,
): PendingRevocation => ({
  userId,
  sealed: `${userId}-sealed`,
  refreshToken,
});

const NOW = new Date('2026-10-26T12:00:00Z');

beforeEach(() => {
  vi.resetAllMocks();
  grants.requestLapsedRevocations.mockResolvedValue(0);
  grants.pendingRevocations.mockResolvedValue([]);
  google.revoke.mockResolvedValue(true);
  channels.stopAll.mockResolvedValue(undefined);
});

describe('disconnect', () => {
  it('stops using the grant, revokes it, and only then removes it', async () => {
    grants.pendingRevocations.mockResolvedValue([pending('user-1')]);
    const order: string[] = [];
    grants.requestRevocation.mockImplementation(() => order.push('marked'));
    google.revoke.mockImplementation(() => {
      order.push('revoked');
      return Promise.resolve(true);
    });
    grants.removeRevoked.mockImplementation(() => order.push('removed'));

    await revocations().disconnect('user-1', NOW);

    expect(tokens.evict).toHaveBeenCalledWith('user-1');
    expect(grants.requestRevocation).toHaveBeenCalledWith('user-1', NOW);
    expect(grants.pendingRevocations).toHaveBeenCalledWith(NOW, 'user-1');
    expect(google.revoke).toHaveBeenCalledWith('user-1-refresh');
    expect(order).toEqual(['marked', 'revoked', 'removed']);
  });

  it('keeps the grant, unused, when Google does not confirm', async () => {
    grants.pendingRevocations.mockResolvedValue([pending('user-1')]);
    google.revoke.mockResolvedValue(false);

    await revocations().disconnect('user-1', NOW);

    expect(grants.requestRevocation).toHaveBeenCalled();
    expect(grants.removeRevoked).not.toHaveBeenCalled();
    expect(grants.revocationFailed).toHaveBeenCalledWith(
      pending('user-1'),
      NOW,
    );
  });
});

describe('sweep', () => {
  it('marks the grants of people whose access ended, and revokes every pending one', async () => {
    grants.requestLapsedRevocations.mockResolvedValue(2);
    grants.pendingRevocations.mockResolvedValue([
      pending('left'),
      pending('retried'),
    ]);

    await revocations().sweep(NOW);

    expect(grants.requestLapsedRevocations).toHaveBeenCalledWith(NOW);
    expect(grants.pendingRevocations).toHaveBeenCalledWith(NOW);
    expect(tokens.clear).toHaveBeenCalled();
    expect(google.revoke).toHaveBeenCalledWith('left-refresh');
    expect(google.revoke).toHaveBeenCalledWith('retried-refresh');
    expect(grants.removeRevoked).toHaveBeenCalledTimes(2);
  });

  it('removes only what Google confirmed, leaving the rest for next time', async () => {
    const confirmed = pending('confirmed');
    grants.pendingRevocations.mockResolvedValue([
      confirmed,
      pending('refused'),
    ]);
    google.revoke.mockImplementation((token: string) =>
      Promise.resolve(token === 'confirmed-refresh'),
    );

    await revocations().sweep(NOW);

    expect(grants.removeRevoked).toHaveBeenCalledTimes(1);
    expect(grants.removeRevoked).toHaveBeenCalledWith(confirmed);
    expect(grants.revocationFailed).toHaveBeenCalledTimes(1);
    expect(grants.revocationFailed).toHaveBeenCalledWith(
      pending('refused'),
      NOW,
    );
  });

  // Still live at Google: a wrong key must not drop every pending grant.
  it('keeps a grant that does not open, marked, to try again', async () => {
    const unreadable = pending('rotated', null);
    grants.pendingRevocations.mockResolvedValue([unreadable]);

    await revocations().sweep(NOW);

    expect(google.revoke).not.toHaveBeenCalled();
    expect(grants.removeRevoked).not.toHaveBeenCalled();
    expect(grants.revocationFailed).toHaveBeenCalledWith(unreadable, NOW);
    expect(logger.error).toHaveBeenCalled();
  });

  it('revokes a few at a time, not one after another', async () => {
    grants.pendingRevocations.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => pending(`user-${i}`)),
    );
    let inFlight = 0;
    let most = 0;
    google.revoke.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return true;
    });

    await revocations().sweep(NOW);

    expect(google.revoke).toHaveBeenCalledTimes(7);
    expect(most).toBe(5);
  });
});

describe('channels', () => {
  it('stops a grant’s channels before revoking it', async () => {
    grants.pendingRevocations.mockResolvedValue([pending('user-1')]);
    const order: string[] = [];
    channels.stopAll.mockImplementation(() => {
      order.push('stopped');
      return Promise.resolve();
    });
    google.revoke.mockImplementation(() => {
      order.push('revoked');
      return Promise.resolve(true);
    });

    await revocations().disconnect('user-1', NOW);

    expect(channels.stopAll).toHaveBeenCalledWith({
      userId: 'user-1',
      sealed: 'user-1-sealed',
      refreshToken: 'user-1-refresh',
    });
    expect(order).toEqual(['stopped', 'revoked']);
  });

  it('revokes anyway when the channels cannot be stopped', async () => {
    grants.pendingRevocations.mockResolvedValue([pending('user-1')]);
    channels.stopAll.mockRejectedValue(new Error('google down'));

    await revocations().disconnect('user-1', NOW);

    expect(google.revoke).toHaveBeenCalled();
    expect(grants.removeRevoked).toHaveBeenCalled();
  });
});
