import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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

/** A grant waiting to be revoked. No token when it can no longer be opened. */
export interface PendingRevocation {
  userId: string;
  sealed: string;
  refreshToken: string | null;
}

const ADMIN_ROLES = Object.values(SystemRole).filter(hasAdminPowers);

const FIRST_RETRY_MS = 10 * 60 * 1000;
const LAST_RETRY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CalendarGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarGrantsService.name);
  }

  /**
   * Also takes back a revocation still waiting for this member: revoking the
   * old token now would end the grant this one belongs to.
   */
  async save(userId: string, refreshToken: string): Promise<void> {
    const { tokenKey } = requireCalendar(this.config);
    const sealedRefreshToken = sealToken(tokenKey, refreshToken, userId);
    await this.db
      .insert(googleCalendarGrants)
      .values({ userId, sealedRefreshToken })
      .onConflictDoUpdate({
        target: googleCalendarGrants.userId,
        set: {
          sealedRefreshToken,
          revokeRequestedAt: null,
          revokeAttempts: 0,
          revokeRetryAt: null,
          updatedAt: new Date(),
        },
      });
  }

  async find(userId: string): Promise<CalendarGrant | null> {
    const { tokenKey } = requireCalendar(this.config);
    const [row] = await this.db
      .select({ sealed: googleCalendarGrants.sealedRefreshToken })
      .from(googleCalendarGrants)
      .where(
        and(
          eq(googleCalendarGrants.userId, userId),
          isNull(googleCalendarGrants.revokeRequestedAt),
        ),
      );
    if (!row) {
      return null;
    }
    // Unreadable is kept, not deleted: a wrong key on one deployment would
    // otherwise wipe every member's grant. A reconnect overwrites it.
    const refreshToken = this.open(tokenKey, row.sealed, userId);
    return refreshToken ? { userId, refreshToken, sealed: row.sealed } : null;
  }

  /** Google has withdrawn it: nothing to revoke. Only the grant that was read. */
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

  async requestRevocation(userId: string, now: Date): Promise<void> {
    await this.db
      .update(googleCalendarGrants)
      .set({ revokeRequestedAt: now })
      .where(
        and(
          eq(googleCalendarGrants.userId, userId),
          isNull(googleCalendarGrants.revokeRequestedAt),
        ),
      );
  }

  /**
   * Marks for revocation the grants of everybody who can no longer use them:
   * suspended accounts, and anybody who is neither an admin nor holds a live
   * membership.
   */
  async requestLapsedRevocations(now: Date): Promise<number> {
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
    const marked = await this.db
      .update(googleCalendarGrants)
      .set({ revokeRequestedAt: now })
      .where(
        and(
          inArray(googleCalendarGrants.userId, lapsed),
          isNull(googleCalendarGrants.revokeRequestedAt),
        ),
      )
      .returning({ userId: googleCalendarGrants.userId });
    if (marked.length > 0) {
      this.logger.info(
        { count: marked.length },
        'calendar grants to revoke: access ended',
      );
    }
    return marked.length;
  }

  /**
   * The marked grants due a try, those never tried first. Empty while the
   * key is not configured: the tokens cannot be opened, so they wait, still
   * marked, until it is.
   */
  async pendingRevocations(
    now: Date,
    userId?: string,
    limit = 100,
  ): Promise<PendingRevocation[]> {
    const key = calendarTokenKey(this.config);
    if (!key) {
      return [];
    }
    const rows = await this.db
      .select({
        userId: googleCalendarGrants.userId,
        sealed: googleCalendarGrants.sealedRefreshToken,
      })
      .from(googleCalendarGrants)
      .where(
        and(
          isNotNull(googleCalendarGrants.revokeRequestedAt),
          or(
            isNull(googleCalendarGrants.revokeRetryAt),
            lte(googleCalendarGrants.revokeRetryAt, now),
          ),
          userId ? eq(googleCalendarGrants.userId, userId) : undefined,
        ),
      )
      .orderBy(
        sql`${googleCalendarGrants.revokeRetryAt} asc nulls first`,
        asc(googleCalendarGrants.revokeRequestedAt),
      )
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      refreshToken: this.open(key, row.sealed, row.userId),
    }));
  }

  /**
   * Not revoked this time: tried again ten minutes later, then twice as long
   * after each failure, at most a day.
   */
  async revocationFailed(
    pending: PendingRevocation,
    now: Date,
  ): Promise<number> {
    const attempts = googleCalendarGrants.revokeAttempts;
    const [row] = await this.db
      .update(googleCalendarGrants)
      .set({
        revokeAttempts: sql`${attempts} + 1`,
        revokeRetryAt: sql`${now.toISOString()}::timestamptz + least(${FIRST_RETRY_MS} * power(2, ${attempts}), ${LAST_RETRY_MS}) * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(googleCalendarGrants.userId, pending.userId),
          eq(googleCalendarGrants.sealedRefreshToken, pending.sealed),
          isNotNull(googleCalendarGrants.revokeRequestedAt),
        ),
      )
      .returning({ attempts });
    return row?.attempts ?? 0;
  }

  /** Only while still the grant marked: a reconnect since has replaced it. */
  async removeRevoked(pending: PendingRevocation): Promise<void> {
    await this.db
      .delete(googleCalendarGrants)
      .where(
        and(
          eq(googleCalendarGrants.userId, pending.userId),
          eq(googleCalendarGrants.sealedRefreshToken, pending.sealed),
          isNotNull(googleCalendarGrants.revokeRequestedAt),
        ),
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
