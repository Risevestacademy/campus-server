import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { timestamptz } from '../../infra/database/timestamptz.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortRole, cohortMembers } from '../cohorts/schema.js';
import {
  roomLinkInstances,
  roomLinks,
  type NewRoomLinkInstance,
} from '../room-links/schema.js';
import {
  SystemRole,
  UserStatus,
  hasAdminPowers,
  users,
} from '../users/schema.js';
import { AccessTokenCache } from './access-token-cache.js';
import {
  CalendarGrantsService,
  type CalendarGrant,
} from './calendar-grants.service.js';
import { CalendarUnavailableError } from './calendar.exceptions.js';
import {
  GoogleCalendarApi,
  PRIMARY_EVENTS_URL,
  SyncTokenExpiredError,
} from './google-calendar-api.js';
import { GrantWithdrawnError } from './google-calendar.client.js';
import type { GoogleEvent } from './google-event.js';
import { googleCalendarGrants } from './schema.js';
import { extractRoomLinkCode } from './room-link.js';

const LEASE_MS = 5 * 60_000;
const SYNC_BUDGET_MS = 60_000;
const PAGE_SIZE = 250;
export const MAX_SYNC_PAGES = 40;
export const FULL_SYNC_LOOKBACK_MS = 86_400_000;
const SYNC_FIELDS =
  'nextPageToken,nextSyncToken,items(id,status,start,end,location,description,organizer(self))';
const LINK_MANAGER_ROLES = [CohortRole.Professor, CohortRole.Mentor];
const ADMIN_ROLES = Object.values(SystemRole).filter(hasAdminPowers);

interface SyncPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Cohorts whose room links somebody manages; null for none. */
type ManagedCohorts = 'all' | Set<string> | null;

/**
 * Keeps room_link_instances in step with the Google Calendars of people who
 * manage room links. Only events they organise and that carry a live link of
 * a cohort they manage are kept, as times and status alone.
 */
@Injectable()
export class CalendarSyncService {
  private readonly appUrl: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) config: Env,
    private readonly grants: CalendarGrantsService,
    private readonly api: GoogleCalendarApi,
    private readonly tokens: AccessTokenCache,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarSyncService.name);
    this.appUrl = config.APP_PUBLIC_URL;
  }

  async managesRoomLinks(userId: string, now: Date): Promise<boolean> {
    return (await this.managedCohorts(userId, now)) !== null;
  }

  /** Syncs now, or leaves word for whoever is syncing this grant already. */
  async sync(userId: string, now: Date = new Date()): Promise<void> {
    if (!(await this.acquire(userId, now))) {
      return;
    }
    try {
      let at = now;
      do {
        await this.syncOnce(userId, at);
        at = new Date();
      } while (await this.stillPending(userId, at));
    } catch (err) {
      await this.release(userId);
      throw err;
    }
  }

  private async syncOnce(userId: string, now: Date): Promise<void> {
    const grant = await this.grants.find(userId);
    if (!grant) {
      return;
    }
    try {
      const [row] = await this.db
        .select({ syncToken: googleCalendarGrants.syncToken })
        .from(googleCalendarGrants)
        .where(eq(googleCalendarGrants.userId, userId));
      try {
        await this.read(
          grant,
          row?.syncToken ?? null,
          now,
          AbortSignal.timeout(SYNC_BUDGET_MS),
        );
      } catch (err) {
        if (!(err instanceof SyncTokenExpiredError)) {
          throw err;
        }
        this.logger.info({ userId }, 'calendar sync token expired; full read');
        await this.read(grant, null, now, AbortSignal.timeout(SYNC_BUDGET_MS));
      }
    } catch (err) {
      if (err instanceof GrantWithdrawnError) {
        this.tokens.evict(userId);
        await this.grants.forget(grant);
        this.logger.info({ userId }, 'calendar access withdrawn at google');
        return;
      }
      throw err;
    }
  }

  private async read(
    grant: CalendarGrant,
    syncToken: string | null,
    now: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const from = new Date(now.getTime() - FULL_SYNC_LOOKBACK_MS);
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      const url = new URL(PRIMARY_EVENTS_URL);
      url.search = new URLSearchParams({
        singleEvents: 'true',
        showDeleted: 'true',
        maxResults: String(PAGE_SIZE),
        fields: SYNC_FIELDS,
        ...(syncToken ? { syncToken } : { timeMin: from.toISOString() }),
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const body = await this.api.get<SyncPage>(grant, url, signal);
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      nextSyncToken = body.nextSyncToken;
      if (!pageToken) {
        break;
      }
    }
    if (!nextSyncToken) {
      this.logger.error(
        { userId: grant.userId, items: items.length },
        'calendar sync ran out of pages; nothing applied',
      );
      throw new CalendarUnavailableError();
    }
    await this.apply(
      grant.userId,
      items,
      syncToken ? null : from,
      nextSyncToken,
      now,
    );
  }

  /** `fullFrom` set: everything the organiser still holds from then was read. */
  private async apply(
    organizerId: string,
    read: GoogleEvent[],
    fullFrom: Date | null,
    nextSyncToken: string,
    now: Date,
  ): Promise<void> {
    const items = [
      ...new Map(
        read.filter((i) => i.id).map((i) => [i.id, i] as const),
      ).values(),
    ];
    const managed = await this.managedCohorts(organizerId, now);
    const codes = new Map<string, string>();
    for (const item of items) {
      const code = extractRoomLinkCode(
        this.appUrl,
        item.location ?? null,
        item.description ?? null,
      );
      if (item.id && code) {
        codes.set(item.id, code);
      }
    }
    const links = await this.liveLinks([...new Set(codes.values())]);

    const keep: NewRoomLinkInstance[] = [];
    const drop: string[] = [];
    const droppedSeries: string[] = [];
    for (const item of items) {
      if (!item.id) {
        continue;
      }
      const link = links.get(codes.get(item.id) ?? '');
      const startsAt = item.start?.dateTime;
      const endsAt = item.end?.dateTime;
      const bound =
        item.status !== 'cancelled' &&
        item.organizer?.self === true &&
        link !== undefined &&
        managed !== null &&
        (managed === 'all' || managed.has(link.cohortId)) &&
        startsAt !== undefined &&
        endsAt !== undefined &&
        new Date(endsAt).getTime() > new Date(startsAt).getTime();
      if (bound) {
        keep.push({
          roomLinkId: link.id,
          organizerId,
          googleEventId: item.id,
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          cancelledAt: null,
        });
      } else {
        drop.push(item.id);
        if (item.status === 'cancelled' && !item.id.includes('_')) {
          droppedSeries.push(item.id);
        }
      }
    }

    await this.db.transaction(async (tx) => {
      if (keep.length > 0) {
        await tx
          .insert(roomLinkInstances)
          .values(keep)
          .onConflictDoUpdate({
            target: [
              roomLinkInstances.organizerId,
              roomLinkInstances.googleEventId,
            ],
            set: {
              roomLinkId: sql`excluded.room_link_id`,
              startsAt: sql`excluded.starts_at`,
              endsAt: sql`excluded.ends_at`,
              cancelledAt: null,
              updatedAt: now,
            },
          });
      }
      const live = and(
        eq(roomLinkInstances.organizerId, organizerId),
        isNull(roomLinkInstances.cancelledAt),
      );
      const stale: SQL[] = [];
      if (drop.length > 0) {
        stale.push(inArray(roomLinkInstances.googleEventId, drop));
      }
      for (const series of droppedSeries) {
        stale.push(
          sql`${roomLinkInstances.googleEventId} like ${`${series.replace(/[\\%_]/g, '\\$&')}\\_%`}`,
        );
      }
      if (fullFrom) {
        const unseen = gt(roomLinkInstances.endsAt, fullFrom);
        stale.push(
          keep.length > 0
            ? and(
                unseen,
                notInArray(
                  roomLinkInstances.googleEventId,
                  keep.map((k) => k.googleEventId),
                ),
              )!
            : unseen,
        );
      }
      for (const where of stale) {
        await tx
          .update(roomLinkInstances)
          .set({ cancelledAt: now, updatedAt: now })
          .where(and(live, where));
      }
      await tx
        .update(googleCalendarGrants)
        .set({ syncToken: nextSyncToken, syncedAt: now })
        .where(eq(googleCalendarGrants.userId, organizerId));
    });
  }

  /**
   * Cancels runs still to come that no longer stand, whatever Google's feed
   * says: the link was revoked, or its organiser no longer manages its cohort.
   * The feed only returns events that changed, so these are checked here.
   */
  async reconcile(now: Date): Promise<number> {
    const stillManages = this.db
      .select({ one: sql`1` })
      .from(users)
      .where(
        and(
          eq(users.id, roomLinkInstances.organizerId),
          ne(users.status, UserStatus.Suspended),
          or(
            inArray(users.systemRole, ADMIN_ROLES),
            exists(
              this.db
                .select({ one: sql`1` })
                .from(cohortMembers)
                .where(
                  and(
                    eq(cohortMembers.userId, users.id),
                    eq(cohortMembers.cohortId, roomLinks.cohortId),
                    inArray(cohortMembers.role, LINK_MANAGER_ROLES),
                    isLiveMembership(now),
                  ),
                ),
            ),
          ),
        ),
      );
    const stale = this.db
      .select({ id: roomLinkInstances.id })
      .from(roomLinkInstances)
      .innerJoin(roomLinks, eq(roomLinks.id, roomLinkInstances.roomLinkId))
      .where(
        and(
          isNull(roomLinkInstances.cancelledAt),
          gt(roomLinkInstances.endsAt, now),
          or(isNotNull(roomLinks.revokedAt), notExists(stillManages)),
        ),
      );
    const cancelled = await this.db
      .update(roomLinkInstances)
      .set({ cancelledAt: now, updatedAt: now })
      .where(inArray(roomLinkInstances.id, stale))
      .returning({ id: roomLinkInstances.id });
    if (cancelled.length > 0) {
      this.logger.info(
        { count: cancelled.length },
        'room link runs cancelled: link revoked or organiser no longer manages it',
      );
    }
    return cancelled.length;
  }

  private async liveLinks(
    codes: string[],
  ): Promise<Map<string, { id: string; cohortId: string }>> {
    if (codes.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({
        id: roomLinks.id,
        code: roomLinks.code,
        cohortId: roomLinks.cohortId,
      })
      .from(roomLinks)
      .where(and(inArray(roomLinks.code, codes), isNull(roomLinks.revokedAt)));
    return new Map(rows.map((row) => [row.code, row]));
  }

  private async managedCohorts(
    userId: string,
    now: Date,
  ): Promise<ManagedCohorts> {
    const [account] = await this.db
      .select({ systemRole: users.systemRole, status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    if (!account || account.status === UserStatus.Suspended) {
      return null;
    }
    if (hasAdminPowers(account.systemRole)) {
      return 'all';
    }
    const rows = await this.db
      .select({ cohortId: cohortMembers.cohortId })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, userId),
          inArray(cohortMembers.role, LINK_MANAGER_ROLES),
          isLiveMembership(now),
        ),
      );
    return rows.length > 0 ? new Set(rows.map((r) => r.cohortId)) : null;
  }

  /** One statement, so a sync ending and a change arriving cannot miss. */
  private async acquire(userId: string, now: Date): Promise<boolean> {
    const free = sql`(${googleCalendarGrants.syncLeaseUntil} is null or ${googleCalendarGrants.syncLeaseUntil} < ${timestamptz(now)})`;
    const [row] = await this.db
      .update(googleCalendarGrants)
      .set({
        syncLeaseUntil: sql`case when ${free} then ${timestamptz(new Date(now.getTime() + LEASE_MS))} else ${googleCalendarGrants.syncLeaseUntil} end`,
        syncPending: sql`not ${free}`,
      })
      .where(
        and(
          eq(googleCalendarGrants.userId, userId),
          isNull(googleCalendarGrants.revokeRequestedAt),
        ),
      )
      .returning({ pending: googleCalendarGrants.syncPending });
    return row !== undefined && !row.pending;
  }

  /** Lets go, unless a change arrived meanwhile: then keeps it for another pass. */
  private async stillPending(userId: string, now: Date): Promise<boolean> {
    const [row] = await this.db
      .update(googleCalendarGrants)
      .set({
        syncLeaseUntil: sql`case when ${googleCalendarGrants.syncPending} then ${timestamptz(new Date(now.getTime() + LEASE_MS))} else null end`,
        syncPending: false,
      })
      .where(eq(googleCalendarGrants.userId, userId))
      .returning({ lease: googleCalendarGrants.syncLeaseUntil });
    return row?.lease != null;
  }

  private async release(userId: string): Promise<void> {
    await this.db
      .update(googleCalendarGrants)
      .set({ syncLeaseUntil: null })
      .where(eq(googleCalendarGrants.userId, userId));
  }
}
