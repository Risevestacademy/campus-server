import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import { CalendarChannelsService } from './calendar-channels.service.js';
import { CalendarGrantsService } from './calendar-grants.service.js';
import { CalendarRevocationService } from './calendar-revocation.service.js';
import { CalendarSyncService } from './calendar-sync.service.js';

export const SYNC_JOB_MS = 5 * 60_000;
export const BACKSTOP_MS = 60 * 60_000;
export const REVOCATION_JOB_MS = 10 * 60_000;
const GRANTS_PER_RUN = 100;
const PARALLEL_GRANTS = 5;

/**
 * Watches the calendars of people who manage room links: a push channel
 * each, renewed before it lapses, and an hourly sync behind it since Google
 * drops some notifications.
 */
@Injectable()
export class CalendarWatchService implements OnModuleInit {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    private readonly scheduler: Scheduler,
    private readonly grants: CalendarGrantsService,
    private readonly channels: CalendarChannelsService,
    private readonly sync: CalendarSyncService,
    private readonly revocations: CalendarRevocationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalendarWatchService.name);
  }

  onModuleInit(): void {
    this.scheduler.register({
      name: 'calendar-revocations',
      everyMs: REVOCATION_JOB_MS,
      run: (now) => this.revocations.sweep(now),
    });
    this.scheduler.register({
      name: 'calendar-sync',
      everyMs: SYNC_JOB_MS,
      run: (now) => this.watchAll(now),
    });
  }

  async watchAll(now: Date): Promise<void> {
    if (!this.config.FF_GOOGLE_CALENDAR_ENABLED) {
      return;
    }
    const grants = await this.grants.watchable(now, GRANTS_PER_RUN);
    for (let i = 0; i < grants.length; i += PARALLEL_GRANTS) {
      await Promise.all(
        grants
          .slice(i, i + PARALLEL_GRANTS)
          .map(({ userId, syncedAt }) =>
            this.refresh(
              userId,
              now,
              !syncedAt || now.getTime() - syncedAt.getTime() >= BACKSTOP_MS,
            ).catch((err: unknown) =>
              this.logger.error({ err, userId }, 'calendar watch failed'),
            ),
          ),
      );
    }
  }

  /** Never rejects: a connect has already succeeded whatever this does. */
  afterConnect(userId: string): void {
    this.refresh(userId, new Date(), true).catch((err: unknown) =>
      this.logger.error({ err, userId }, 'calendar watch failed'),
    );
  }

  private async refresh(
    userId: string,
    now: Date,
    syncNow: boolean,
  ): Promise<void> {
    const grant = await this.grants.find(userId);
    if (!grant) {
      return;
    }
    if (!(await this.sync.managesRoomLinks(userId, now))) {
      await this.channels.stopAll(grant);
      await this.sync.forgetOrganizer(userId, now);
      return;
    }
    await this.channels.ensure(grant, now);
    if (syncNow) {
      await this.sync.sync(userId, now);
    }
  }
}
