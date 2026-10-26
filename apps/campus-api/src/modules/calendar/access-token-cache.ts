import { Injectable } from '@nestjs/common';

import type { CalendarGrant } from './calendar-grants.service.js';
import {
  GoogleCalendarClient,
  type CalendarAccessToken,
} from './google-calendar.client.js';

const EXPIRY_MARGIN_MS = 60_000;

/** Access tokens by account, kept in memory until a minute before they lapse. */
@Injectable()
export class AccessTokenCache {
  private readonly tokens = new Map<string, CalendarAccessToken>();

  constructor(private readonly google: GoogleCalendarClient) {}

  async get(grant: CalendarGrant): Promise<string> {
    const now = Date.now();
    const cached = this.tokens.get(grant.userId);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) {
      return cached.token;
    }
    const fresh = await this.google.refresh(grant.refreshToken);
    for (const [userId, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(userId);
      }
    }
    this.tokens.set(grant.userId, fresh);
    return fresh.token;
  }

  evict(userId: string): void {
    this.tokens.delete(userId);
  }

  clear(): void {
    this.tokens.clear();
  }
}
