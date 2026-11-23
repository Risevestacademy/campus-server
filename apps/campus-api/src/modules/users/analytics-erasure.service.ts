import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { Scheduler } from '../../infra/scheduler/scheduler.js';
import { UserStatus, users } from './schema.js';

export const ANALYTICS_ERASURE_FETCH = Symbol('ANALYTICS_ERASURE_FETCH');

const ERASURE_JOB_MS = 10 * 60_000;
/** PostHog's limit for one bulk delete. */
const BATCH = 1000;

/**
 * Drops deleted accounts' person profiles from PostHog, keeping their events
 * under an id that no longer leads to anybody. Runs on a schedule rather than
 * inside the deletion, so PostHog being down delays it and never blocks it.
 */
@Injectable()
export class AnalyticsErasureService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    @Inject(ANALYTICS_ERASURE_FETCH) private readonly fetcher: typeof fetch,
    private readonly scheduler: Scheduler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsErasureService.name);
  }

  onModuleInit(): void {
    this.scheduler.register({
      name: 'analytics-erasure',
      everyMs: ERASURE_JOB_MS,
      run: (now) => this.erase(now),
    });
  }

  async erase(now: Date): Promise<void> {
    const key = this.config.POSTHOG_PERSONAL_API_KEY;
    const projectId = this.config.POSTHOG_PROJECT_ID;
    if (!key || !projectId) return;

    const waiting = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, UserStatus.Deleted),
          isNull(users.analyticsErasedAt),
        ),
      )
      .limit(BATCH);
    if (waiting.length === 0) return;
    const ids = waiting.map((row) => row.id);

    const host = this.config.POSTHOG_API_HOST.replace(/\/+$/, '');
    const response = await this.fetcher(
      `${host}/api/projects/${projectId}/persons/bulk_delete/`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          distinct_ids: ids,
          delete_events: false,
          delete_recordings: true,
        }),
      },
    );
    if (!response.ok) {
      this.logger.warn(
        { status: response.status, waiting: ids.length },
        'PostHog refused the person deletions; trying again next run',
      );
      return;
    }

    await this.db
      .update(users)
      .set({ analyticsErasedAt: now })
      .where(inArray(users.id, ids));
    this.logger.info({ erased: ids.length }, 'PostHog person profiles deleted');
  }
}
