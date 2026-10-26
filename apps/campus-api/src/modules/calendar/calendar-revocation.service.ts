import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AccessTokenCache } from './access-token-cache.js';
import {
  CalendarGrantsService,
  type PendingRevocation,
} from './calendar-grants.service.js';
import { GoogleCalendarClient } from './google-calendar.client.js';

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PARALLEL_REVOCATIONS = 5;

/**
 * Takes grants back: a member disconnecting, and the grants of people whose
 * access has ended. Revoked at Google first; the row goes only once Google
 * confirms. One it does not confirm, or whose token does not open, is tried
 * again at a later sweep, waiting longer after each failure.
 */
@Injectable()
export class CalendarRevocationService {
  private lastSweep = 0;

  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly google: GoogleCalendarClient,
    private readonly tokens: AccessTokenCache,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarRevocationService.name);
  }

  /** From now on the grant is not used, whatever Google answers. */
  async disconnect(userId: string, now: Date = new Date()): Promise<void> {
    this.tokens.evict(userId);
    await this.grants.requestRevocation(userId, now);
    await this.revokeAll(
      await this.grants.pendingRevocations(now, userId),
      now,
    );
  }

  async sweep(now: Date = new Date()): Promise<void> {
    this.lastSweep = now.getTime();
    if ((await this.grants.requestLapsedRevocations(now)) > 0) {
      this.tokens.clear();
    }
    await this.revokeAll(await this.grants.pendingRevocations(now), now);
  }

  /**
   * At most every ten minutes, on the back of calendar requests rather than a
   * timer: a timer would keep the API awake, and it sleeps when idle.
   */
  sweepIfDue(now: number = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    this.sweep(new Date(now)).catch((err: unknown) =>
      this.logger.error({ err }, 'calendar revocation sweep failed'),
    );
  }

  private async revokeAll(
    pending: PendingRevocation[],
    now: Date,
  ): Promise<void> {
    for (let i = 0; i < pending.length; i += PARALLEL_REVOCATIONS) {
      await Promise.all(
        pending
          .slice(i, i + PARALLEL_REVOCATIONS)
          .map((grant) => this.revoke(grant, now)),
      );
    }
  }

  private async revoke(pending: PendingRevocation, now: Date): Promise<void> {
    if (
      pending.refreshToken &&
      (await this.google.revoke(pending.refreshToken))
    ) {
      await this.grants.removeRevoked(pending);
      return;
    }
    const attempts = await this.grants.revocationFailed(pending, now);
    if (!pending.refreshToken) {
      // Still live at Google: kept, marked, until the right key is back.
      this.logger.error(
        { userId: pending.userId, attempts },
        'calendar grant to revoke does not open: check GOOGLE_CALENDAR_TOKEN_KEY',
      );
    }
  }
}
