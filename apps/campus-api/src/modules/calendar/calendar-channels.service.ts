import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { CalendarGrant } from './calendar-grants.service.js';
import {
  CALENDAR_API,
  GoogleCalendarApi,
  PRIMARY_EVENTS_URL,
} from './google-calendar-api.js';
import { googleCalendarChannels } from './schema.js';

export const CHANNEL_TTL_MS = 7 * 86_400_000;
export const RENEW_BEFORE_MS = 86_400_000;
const REQUEST_BUDGET_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WatchAnswer {
  resourceId?: string;
  expiration?: string;
}

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Google push channels, one live per watched grant. */
@Injectable()
export class CalendarChannelsService {
  private readonly address: string | undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) config: Env,
    private readonly api: GoogleCalendarApi,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarChannelsService.name);
    this.address = config.GOOGLE_CALENDAR_WEBHOOK_URL;
  }

  /** Opens a channel unless one lasts past the renewal margin, then stops the rest. */
  async ensure(grant: CalendarGrant, now: Date): Promise<void> {
    if (!this.address) {
      return;
    }
    const [lasting] = await this.db
      .select({ id: googleCalendarChannels.id })
      .from(googleCalendarChannels)
      .where(
        and(
          eq(googleCalendarChannels.userId, grant.userId),
          gt(
            googleCalendarChannels.expiresAt,
            new Date(now.getTime() + RENEW_BEFORE_MS),
          ),
        ),
      )
      .limit(1);
    if (lasting) {
      return;
    }

    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const answer = await this.api.post<WatchAnswer>(
      grant,
      new URL(`${PRIMARY_EVENTS_URL}/watch`),
      {
        id,
        type: 'web_hook',
        address: this.address,
        token,
        expiration: now.getTime() + CHANNEL_TTL_MS,
      },
      AbortSignal.timeout(REQUEST_BUDGET_MS),
    );
    if (!answer?.resourceId) {
      this.logger.error(
        { userId: grant.userId },
        'google opened a calendar channel without a resource id',
      );
      return;
    }
    const expiresAt = answer.expiration
      ? new Date(Number(answer.expiration))
      : new Date(now.getTime() + CHANNEL_TTL_MS);
    const [opened] = await this.db
      .insert(googleCalendarChannels)
      .values({
        id,
        userId: grant.userId,
        resourceId: answer.resourceId,
        tokenHash: hash(token),
        expiresAt,
      })
      .returning({ createdAt: googleCalendarChannels.createdAt });
    await this.stopAll(grant, opened.createdAt);
  }

  /**
   * Best effort at Google; the rows go regardless. With `openedBefore`, only
   * older channels, so two renewals at once leave the newer one standing.
   */
  async stopAll(grant: CalendarGrant, openedBefore?: Date): Promise<void> {
    const channels = await this.db
      .select()
      .from(googleCalendarChannels)
      .where(
        and(
          eq(googleCalendarChannels.userId, grant.userId),
          openedBefore
            ? lt(googleCalendarChannels.createdAt, openedBefore)
            : undefined,
        ),
      );
    for (const channel of channels) {
      try {
        await this.api.post(
          grant,
          new URL(`${CALENDAR_API}/channels/stop`),
          { id: channel.id, resourceId: channel.resourceId },
          AbortSignal.timeout(REQUEST_BUDGET_MS),
        );
      } catch (err) {
        this.logger.warn(
          { err, userId: grant.userId, channelId: channel.id },
          'calendar channel not stopped at google',
        );
      }
      await this.db
        .delete(googleCalendarChannels)
        .where(eq(googleCalendarChannels.id, channel.id));
    }
  }

  /** Whose calendar a notification is about, or null when it is not ours. */
  async verify(
    channelId: string | undefined,
    token: string | undefined,
  ): Promise<string | null> {
    if (!channelId || !token || !UUID.test(channelId)) {
      return null;
    }
    const [channel] = await this.db
      .select({
        userId: googleCalendarChannels.userId,
        tokenHash: googleCalendarChannels.tokenHash,
      })
      .from(googleCalendarChannels)
      .where(eq(googleCalendarChannels.id, channelId));
    if (!channel) {
      return null;
    }
    const given = Buffer.from(hash(token));
    const kept = Buffer.from(channel.tokenHash);
    return given.length === kept.length && timingSafeEqual(given, kept)
      ? channel.userId
      : null;
  }
}
