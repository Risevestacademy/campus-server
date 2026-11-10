import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { PinoLogger } from 'nestjs-pino';

import { Scheduler } from './scheduler.js';

const MIGRATIONS = fileURLToPath(
  new URL('../database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const logger = { error: vi.fn(), setContext: vi.fn() };
const scheduler = () =>
  new Scheduler(db as never, logger as unknown as PinoLogger);

const NOW = new Date('2026-11-09T08:00:00Z');
const MINUTE = 60_000;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  vi.resetAllMocks();
  await db.execute(sql`truncate scheduled_jobs`);
});

it('runs a job once per interval, however many replicas tick', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const [a, b] = [scheduler(), scheduler()];
  for (const replica of [a, b]) {
    replica.register({ name: 'job', everyMs: 5 * MINUTE, run });
  }

  await a.tick(NOW);
  await b.tick(NOW);
  await a.tick(new Date(NOW.getTime() + 4 * MINUTE));
  expect(run).toHaveBeenCalledTimes(1);

  await b.tick(new Date(NOW.getTime() + 5 * MINUTE));
  expect(run).toHaveBeenCalledTimes(2);
});

it('runs an overdue job on the first tick after a long sleep', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const first = scheduler();
  first.register({ name: 'job', everyMs: MINUTE, run });
  await first.tick(NOW);

  const woken = scheduler();
  woken.register({ name: 'job', everyMs: MINUTE, run });
  await woken.tick(new Date(NOW.getTime() + 3 * 60 * MINUTE));

  expect(run).toHaveBeenCalledTimes(2);
});

it('logs a failing job and still runs the next', async () => {
  const next = vi.fn().mockResolvedValue(undefined);
  const s = scheduler();
  s.register({
    name: 'broken',
    everyMs: MINUTE,
    run: () => Promise.reject(new Error('boom')),
  });
  s.register({ name: 'next', everyMs: MINUTE, run: next });

  await s.tick(NOW);

  expect(logger.error).toHaveBeenCalled();
  expect(next).toHaveBeenCalled();
});

it('ticks on the back of requests at most once a minute', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const s = scheduler();
  s.register({ name: 'job', everyMs: 0, run });

  s.nudge(NOW.getTime());
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  s.nudge(NOW.getTime() + MINUTE - 1);
  s.nudge(NOW.getTime() + MINUTE);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});
