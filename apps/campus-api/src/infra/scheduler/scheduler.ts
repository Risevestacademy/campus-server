import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { lte } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';

import { DRIZZLE, type Db } from '../database/database.constants.js';
import { scheduledJobs } from './schema.js';

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run(now: Date): Promise<void>;
}

const TICK_MS = 60_000;

/**
 * Runs each registered job at most once per interval across every replica:
 * a replica claims a run by moving the job's next_run_at forward, and only a
 * claim that finds it due succeeds. An API that slept runs what is due on
 * its first tick.
 */
@Injectable()
export class Scheduler implements OnApplicationShutdown {
  private readonly jobs: ScheduledJob[] = [];
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastTick = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(Scheduler.name);
  }

  register(job: ScheduledJob): void {
    this.jobs.push(job);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  /** For an API that sleeps: a tick on the back of a request, at most every minute. */
  nudge(now: number = Date.now()): void {
    if (now - this.lastTick >= TICK_MS) {
      void this.tick(new Date(now));
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    this.lastTick = now.getTime();
    try {
      for (const job of this.jobs) {
        await this.runIfDue(job, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runIfDue(job: ScheduledJob, now: Date): Promise<void> {
    try {
      const next = new Date(now.getTime() + job.everyMs);
      const claimed = await this.db
        .insert(scheduledJobs)
        .values({ name: job.name, nextRunAt: next })
        .onConflictDoUpdate({
          target: scheduledJobs.name,
          set: { nextRunAt: next },
          setWhere: lte(scheduledJobs.nextRunAt, now),
        })
        .returning({ name: scheduledJobs.name });
      if (claimed.length === 0) {
        return;
      }
      await job.run(now);
    } catch (err) {
      this.logger.error({ err, job: job.name }, 'scheduled job failed');
    }
  }
}
