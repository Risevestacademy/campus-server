import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  exists,
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
import { timestamptz } from '../../infra/database/timestamptz.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortRole, cohortMembers } from '../cohorts/schema.js';
import {
  SystemRole,
  UserStatus,
  hasAdminPowers,
  users,
} from '../users/schema.js';
import { calendarTokenKey, requireCalendar } from './calendar.settings.js';
import { googleCalendarChannels, googleCalendarGrants } from './schema.js';
import { openToken, sealToken } from './token-cipher.js';

export interface CalendarGrant {
  userId: string;
  refreshToken: string;
  sealed: string;
}

/** No token when it can no longer be opened. */
export interface PendingRevocation {
  userId: string;
  sealed: string;
  refreshToken: string | null;
}

const ADMIN_ROLES = Object.values(SystemRole).filter(hasAdminPowers);
const LINK_MANAGER_ROLES = [CohortRole.Professor, CohortRole.Mentor];

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

  /** Takes back a pending revocation: Google revokes a whole grant at once. */
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
    // Kept, not deleted: a wrong key would otherwise wipe every grant.
    const refreshToken = this.open(tokenKey, row.sealed, userId);
    return refreshToken ? { userId, refreshToken, sealed: row.sealed } : null;
  }

  /** Google has withdrawn it. Only the grant that was read. */
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
   * Grants to watch or stop watching, synced longest ago first: those of
   * people who manage room links, and any still holding a channel.
   */
  async watchable(
    now: Date,
    limit: number,
  ): Promise<{ userId: string; syncedAt: Date | null }[]> {
    const manager = this.db
      .select({ one: sql`1` })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, googleCalendarGrants.userId),
          inArray(cohortMembers.role, LINK_MANAGER_ROLES),
          isLiveMembership(now),
        ),
      );
    const admin = this.db
      .select({ one: sql`1` })
      .from(users)
      .where(
        and(
          eq(users.id, googleCalendarGrants.userId),
          inArray(users.systemRole, ADMIN_ROLES),
        ),
      );
    const watched = this.db
      .select({ one: sql`1` })
      .from(googleCalendarChannels)
      .where(eq(googleCalendarChannels.userId, googleCalendarGrants.userId));
    return this.db
      .select({
        userId: googleCalendarGrants.userId,
        syncedAt: googleCalendarGrants.syncedAt,
      })
      .from(googleCalendarGrants)
      .where(
        and(
          isNull(googleCalendarGrants.revokeRequestedAt),
          or(exists(manager), exists(admin), exists(watched)),
        ),
      )
      .orderBy(sql`${googleCalendarGrants.syncedAt} asc nulls first`)
      .limit(limit);
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

  /** Suspended accounts, and anybody neither an admin nor a live member. */
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

  /** Due a try, never-tried first. Empty without a key: they wait, marked. */
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

  /** Retried after ten minutes, doubling, at most a day. */
  async revocationFailed(
    pending: PendingRevocation,
    now: Date,
  ): Promise<number> {
    const attempts = googleCalendarGrants.revokeAttempts;
    const [row] = await this.db
      .update(googleCalendarGrants)
      .set({
        revokeAttempts: sql`${attempts} + 1`,
        revokeRetryAt: sql`${timestamptz(now)} + least(${FIRST_RETRY_MS} * power(2, ${attempts}), ${LAST_RETRY_MS}) * interval '1 millisecond'`,
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

  /** Only while still the grant marked; a reconnect may have replaced it. */
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
