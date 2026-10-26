import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { UsersService } from '../users/users.service.js';
import { AccessTokenCache } from './access-token-cache.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarStateService } from './calendar-state.service.js';
import { CalendarConnectFailedError } from './calendar.exceptions.js';
import { GOOGLE_CALENDAR_SCOPE } from './calendar.settings.js';
import type { CalendarCallbackQueryDto } from './dto/calendar-connect.dto.js';
import {
  GoogleCalendarClient,
  type RedeemedCalendarCode,
} from './google-calendar.client.js';

/** A member connecting their calendar, from the web or a native app. */
@Injectable()
export class CalendarConnectService {
  constructor(
    private readonly grants: CalendarGrantsService,
    private readonly google: GoogleCalendarClient,
    private readonly states: CalendarStateService,
    private readonly tokens: AccessTokenCache,
    private readonly users: UsersService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarConnectService.name);
  }

  connectUrl(user: AuthenticatedUser): string {
    return this.google.authorizationUrl(this.states.issue(user.id), user.email);
  }

  async completeConnect(
    userId: string,
    query: CalendarCallbackQueryDto,
  ): Promise<void> {
    this.states.verify(query.state, userId);
    if (query.error) {
      throw new CalendarConnectFailedError('denied');
    }
    if (!query.code) {
      throw new CalendarConnectFailedError('missing_code');
    }
    await this.keep(userId, await this.google.redeemWebCode(query.code));
  }

  async connectWithAppCode(
    userId: string,
    serverAuthCode: string,
  ): Promise<void> {
    await this.keep(userId, await this.google.redeemAppCode(serverAuthCode));
  }

  private async keep(
    userId: string,
    redeemed: RedeemedCalendarCode,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.providerId || user.providerId !== redeemed.subject) {
      // Another Google account's calendar: nothing of it is kept, and its
      // owner is not left with campus on their account.
      await this.google.revoke(redeemed.refreshToken ?? redeemed.accessToken);
      throw new CalendarConnectFailedError('wrong_account');
    }
    if (!redeemed.scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
      throw new CalendarConnectFailedError('not_granted');
    }
    // Not revoked: that would end the member's whole grant, and with it a
    // connection they may already have.
    if (!redeemed.refreshToken) {
      throw new CalendarConnectFailedError('no_refresh_token');
    }
    await this.grants.save(userId, redeemed.refreshToken);
    this.tokens.evict(userId);
    this.logger.info({ userId }, 'calendar connected');
  }
}
