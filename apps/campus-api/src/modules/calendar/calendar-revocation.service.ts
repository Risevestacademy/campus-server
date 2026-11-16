import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AccessTokenCache } from './access-token-cache.js';
import { CalendarChannelsService } from './calendar-channels.service.js';
import {
  CalendarGrantsService,
  type PendingRevocation,
} from './calendar-grants.service.js';
import { GoogleCalendarClient } from './google-calendar.client.js';

const PARALLEL_REVOCATIONS = 5;

/**
 * Takes grants back, revoked at Google first; the row goes only once Google
 * confirms. Unconfirmed ones are retried by later sweeps, further apart each
 * time.
 */
@Injectable()
export class CalendarRevocationService {
  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly google: GoogleCalendarClient,
    private readonly tokens: AccessTokenCache,
    private readonly channels: CalendarChannelsService,
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
    if ((await this.grants.requestLapsedRevocations(now)) > 0) {
      this.tokens.clear();
    }
    await this.revokeAll(await this.grants.pendingRevocations(now), now);
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
    if (pending.refreshToken) {
      await this.channels
        .stopAll({ ...pending, refreshToken: pending.refreshToken })
        .catch((err: unknown) =>
          this.logger.warn(
            { err, userId: pending.userId },
            'calendar channels not stopped before revoking',
          ),
        );
      if (await this.google.revoke(pending.refreshToken)) {
        await this.grants.removeRevoked(pending);
        return;
      }
    }
    const attempts = await this.grants.revocationFailed(pending, now);
    if (!pending.refreshToken) {
      this.logger.error(
        { userId: pending.userId, attempts },
        'calendar grant to revoke does not open: check GOOGLE_CALENDAR_TOKEN_KEY',
      );
    }
  }
}
