import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, notExists, notInArray, or, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers } from '../cohorts/schema.js';
import {
  SystemRole,
  UserStatus,
  hasAdminPowers,
  users,
} from '../users/schema.js';
import { calendarTokenKey, requireCalendar } from './calendar.settings.js';
import { googleCalendarGrants } from './schema.js';
import { openToken, sealToken } from './token-cipher.js';

export interface CalendarGrant {
  userId: string;
  refreshToken: string;
  sealed: string;
}

const ADMIN_ROLES = Object.values(SystemRole).filter(hasAdminPowers);

@Injectable()
export class CalendarGrantsService {
  private key?: Buffer;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarGrantsService.name);
  }

  private get tokenKey(): Buffer {
    return (this.key ??= requireCalendar(this.config).tokenKey);
  }

  async save(userId: string, refreshToken: string): Promise<void> {
    const sealedRefreshToken = sealToken(this.tokenKey, refreshToken, userId);
    await this.db
      .insert(googleCalendarGrants)
      .values({ userId, sealedRefreshToken })
      .onConflictDoUpdate({
        target: googleCalendarGrants.userId,
        set: { sealedRefreshToken, updatedAt: new Date() },
      });
  }

  async find(userId: string): Promise<CalendarGrant | null> {
    const [row] = await this.db
      .select({ sealed: googleCalendarGrants.sealedRefreshToken })
      .from(googleCalendarGrants)
      .where(eq(googleCalendarGrants.userId, userId));
    if (!row) {
      return null;
    }
    // Unreadable is kept, not deleted: a wrong key on one deployment would
    // otherwise wipe every member's grant. A reconnect overwrites it.
    const refreshToken = this.open(this.tokenKey, row.sealed, userId);
    return refreshToken ? { userId, refreshToken, sealed: row.sealed } : null;
  }

  /** Only the grant that was read: one saved since by a reconnect stays. */
  async forget(grant: CalendarGrant): Promise<void> {
    await this.db
      .delete(googleCalendarGrants)
      .where(
        and(
          eq(googleCalendarGrants.userId, grant.userId),
          eq(googleCalendarGrants.sealedRefreshToken, grant.sealed),
        ),
      );
  }

  /**
   * Deletes the member's grant and hands back its refresh token, to revoke.
   * Works while the calendar is switched off; the token comes back only if
   * the key is still configured.
   */
  async remove(userId: string): Promise<string | null> {
    const removed = await this.db
      .delete(googleCalendarGrants)
      .where(eq(googleCalendarGrants.userId, userId))
      .returning({
        userId: googleCalendarGrants.userId,
        sealed: googleCalendarGrants.sealedRefreshToken,
      });
    return this.openAll(removed)[0] ?? null;
  }

  /**
   * Deletes the grants of everybody who can no longer use them: suspended
   * accounts, and anybody who is neither an admin nor holds a live
   * membership. Hands back their refresh tokens, to revoke.
   */
  async removeLapsed(now: Date): Promise<string[]> {
    const live = this.db
      .select({ one: sql`1` })
      .from(cohortMembers)
      .where(and(eq(cohortMembers.userId, users.id), isLiveMembership(now)));
    const lapsed = this.db
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          eq(users.status, UserStatus.Suspended),
          and(notInArray(users.systemRole, ADMIN_ROLES), notExists(live)),
        ),
      );
    const removed = await this.db
      .delete(googleCalendarGrants)
      .where(inArray(googleCalendarGrants.userId, lapsed))
      .returning({
        userId: googleCalendarGrants.userId,
        sealed: googleCalendarGrants.sealedRefreshToken,
      });
    if (removed.length > 0) {
      this.logger.info(
        { count: removed.length },
        'calendar grants removed: access ended',
      );
    }
    return this.openAll(removed);
  }

  private openAll(rows: { userId: string; sealed: string }[]): string[] {
    const key = calendarTokenKey(this.config);
    if (!key) {
      return [];
    }
    return rows.flatMap(
      ({ userId, sealed }) => this.open(key, sealed, userId) ?? [],
    );
  }

  private open(key: Buffer, sealed: string, userId: string): string | null {
    try {
      return openToken(key, sealed, userId);
    } catch (err) {
      this.logger.error({ err, userId }, 'calendar grant does not open');
      return null;
    }
  }
}
