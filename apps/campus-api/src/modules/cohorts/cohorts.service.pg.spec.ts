import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { CohortsService } from './cohorts.service.js';
import { cohorts } from './schema.js';

const ROUNDS = 40;
const audit = { actorUserId: null };

/**
 * What the row lock in update() is for. The request check looks at each date
 * on its own; whether the pair still makes sense can only be judged against
 * the row. Two edits that each move one date are both fine against the old
 * pair, and unlocked both would be written: an end before the start.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)('CohortsService, two edits at once', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let service: CohortsService;

  beforeAll(() => {
    pg = connectRealPostgres();
    service = new CohortsService(pg.db as never);
  });

  afterAll(async () => {
    await pg.close();
  });

  it('never stores an end date before the start date', async () => {
    const wrong: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const tag = unique();
      const [cohort] = await pg.db
        .insert(cohorts)
        .values({
          name: `Cohort ${tag}`,
          code: `C${tag}`.toUpperCase().slice(0, 32),
          startDate: '2026-01-10',
          endDate: '2026-01-20',
        })
        .returning();

      // Each is fine against 10 to 20. Together they would store 15 to 12.
      const results = await Promise.allSettled([
        service.update(cohort.id, { endDate: '2026-01-12' }, audit),
        service.update(cohort.id, { startDate: '2026-01-15' }, audit),
      ]);

      const [stored] = await pg.db
        .select()
        .from(cohorts)
        .where(eq(cohorts.id, cohort.id));
      const applied = results.filter((r) => r.status === 'fulfilled').length;
      const inverted =
        stored.startDate !== null &&
        stored.endDate !== null &&
        stored.endDate < stored.startDate;
      if (inverted || applied !== 1) {
        wrong.push(
          `round ${round}: ${applied} applied, stored ${stored.startDate} to ${stored.endDate}`,
        );
      }
    }

    expect(wrong).toEqual([]);
  }, 120_000);
});
