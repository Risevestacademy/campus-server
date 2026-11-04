import { and, count, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../../infra/database/schema/index.js';
import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { SystemRole, users } from '../users/schema.js';
import { NoticeConflictException } from './notices.exceptions.js';
import { NoticesService } from './notices.service.js';
import { NoticeScope, notices } from './schema.js';

const ROUNDS = 20;
const audit = { actorUserId: null };

type Pg = ReturnType<typeof connectRealPostgres>;

/** A cohort of its own, with a professor of it. */
async function professorsCohort(
  pg: Pg,
): Promise<{ cohortId: string; professor: AuthenticatedUser }> {
  const tag = unique();
  const [cohort] = await pg.db
    .insert(cohorts)
    .values({ name: `Notices ${tag}`, code: `N${tag}`.toUpperCase() })
    .returning();
  const [user] = await pg.db
    .insert(users)
    .values({ email: `prof-${tag}@campus.local`, systemRole: SystemRole.User })
    .returning();
  await pg.db.insert(cohortMembers).values({
    cohortId: cohort.id,
    userId: user.id,
    role: CohortRole.Professor,
  });
  return {
    cohortId: cohort.id,
    professor: { id: user.id, email: user.email, systemRole: user.systemRole },
  };
}

async function notice(
  pg: Pg,
  authorId: string,
  cohortId: string,
  pinned: boolean,
): Promise<string> {
  const [row] = await pg.db
    .insert(notices)
    .values({
      authorId,
      scope: NoticeScope.Cohort,
      cohortId,
      title: 'Notice',
      body: 'Body',
      pinned,
    })
    .returning({ id: notices.id });
  return row.id;
}

/**
 * What the scope lock in pin() is for. The row lock covers only the notice
 * being pinned, so two requests pinning different notices in one scope could
 * each count the same two pins and both go ahead, leaving four. With the
 * scope held until commit, the second counts after the first has written, and
 * is refused.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)('NoticesService, two pins at once', () => {
  let pg: Pg;
  let service: NoticesService;

  beforeAll(() => {
    pg = connectRealPostgres();
    service = new NoticesService(pg.db as never);
  });

  afterAll(async () => {
    await pg.close();
  });

  it('never pins more than three notices in a scope', async () => {
    const over: number[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const { cohortId, professor } = await professorsCohort(pg);
      await notice(pg, professor.id, cohortId, true);
      await notice(pg, professor.id, cohortId, true);
      const a = await notice(pg, professor.id, cohortId, false);
      const b = await notice(pg, professor.id, cohortId, false);

      const results = await Promise.allSettled([
        service.pin(a, true, professor, audit),
        service.pin(b, true, professor, audit),
      ]);

      const [{ pinned }] = await pg.db
        .select({ pinned: count() })
        .from(notices)
        .where(
          and(
            eq(notices.cohortId, cohortId),
            eq(notices.pinned, true),
            isNull(notices.removedAt),
          ),
        );
      const refused = results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof NoticeConflictException,
      ).length;
      if (pinned !== 3 || refused !== 1) {
        over.push(pinned);
      }
    }

    expect(over).toEqual([]);
  });
});

/**
 * Why the permission check reads through the caller's transaction. Checked
 * through the pool instead, every update, pin and remove holds one connection
 * and waits for a second; enough of them at once and none can get one. A
 * pool of one makes that certain: the check would wait on the transaction's
 * own connection for ever.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'NoticesService on a pool of one connection',
  () => {
    let pg: Pg;
    let single: ReturnType<typeof postgres>;
    let service: NoticesService;

    beforeAll(() => {
      pg = connectRealPostgres();
      single = postgres(REAL_POSTGRES_URL as string, {
        max: 1,
        onnotice: () => undefined,
      });
      service = new NoticesService(drizzle(single, { schema }) as never);
    });

    afterAll(async () => {
      await single.end();
      await pg.close();
    });

    it('lets a professor update, pin and remove without a second connection', async () => {
      const { cohortId, professor } = await professorsCohort(pg);
      const id = await notice(pg, professor.id, cohortId, false);

      await service.update(id, { title: 'Edited' }, professor, audit);
      await service.pin(id, true, professor, audit);
      await service.remove(id, professor, audit);

      const [row] = await pg.db
        .select({ title: notices.title, removedAt: notices.removedAt })
        .from(notices)
        .where(eq(notices.id, id));
      expect(row.title).toBe('Edited');
      expect(row.removedAt).not.toBeNull();
    }, 10_000);
  },
);
