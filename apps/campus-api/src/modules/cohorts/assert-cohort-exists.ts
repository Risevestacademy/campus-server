import { eq } from 'drizzle-orm';

import type { DbExecutor } from '../../infra/database/database.constants.js';
import { CohortNotFoundException } from './cohorts.exceptions.js';
import { cohorts } from './schema.js';

/** A 404 for a route about a cohort that does not exist. */
export async function assertCohortExists(
  executor: DbExecutor,
  cohortId: string,
): Promise<void> {
  const [cohort] = await executor
    .select({ id: cohorts.id })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId))
    .limit(1);
  if (!cohort) {
    throw new CohortNotFoundException(`Cohort ${cohortId} not found`, {
      cohortId,
    });
  }
}
