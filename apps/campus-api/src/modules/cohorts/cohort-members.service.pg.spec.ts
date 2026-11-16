import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import { CohortMembersService } from './cohort-members.service.js';
import { CohortConflictException } from './cohorts.exceptions.js';
import { CohortsService } from './cohorts.service.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohortTracks,
  cohorts,
} from './schema.js';

const ROUNDS = 40;
const audit = { actorUserId: null };

/**
 * What the lock on the cohort's link to the target track is for. A move
 * reads that link, then points the membership at it; a detach deletes it.
 * Unlocked, a detach landing between the two leaves the move's update
 * failing the foreign key, which reaches the caller as a 500. Locked, the
 * detach waits: if the move went first the detach finds the student on the
 * track, and if the detach went first the move finds no link. Either way
 * exactly one of the two happens and the other is refused as a 409.
 *
 * See real-postgres.ts for why this cannot run on PGlite.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'CohortMembersService, a move and a detach at once',
  () => {
    let pg: ReturnType<typeof connectRealPostgres>;
    let members: CohortMembersService;
    let cohortsService: CohortsService;

    beforeAll(() => {
      pg = connectRealPostgres();
      members = new CohortMembersService(pg.db as never);
      cohortsService = new CohortsService(pg.db as never);
    });

    afterAll(async () => {
      await pg.close();
    });

    async function studentOnOneOfTwoTracks() {
      const tag = unique();
      const code = (prefix: string) =>
        `${prefix}${tag}`.toUpperCase().slice(0, 32);
      const [{ userId }] = await pg.db
        .insert(users)
        .values({ email: `student-${tag}@campus.local` })
        .returning({ userId: users.id });
      const [{ cohortId }] = await pg.db
        .insert(cohorts)
        .values({ name: `Cohort ${tag}`, code: code('C') })
        .returning({ cohortId: cohorts.id });
      const [{ fromTrackId }, { toTrackId }] = await Promise.all([
        pg.db
          .insert(tracks)
          .values({ name: `From ${tag}`, code: code('F') })
          .returning({ fromTrackId: tracks.id })
          .then(([row]) => row),
        pg.db
          .insert(tracks)
          .values({ name: `To ${tag}`, code: code('T') })
          .returning({ toTrackId: tracks.id })
          .then(([row]) => row),
      ]);
      const [{ fromLinkId }] = await pg.db
        .insert(cohortTracks)
        .values({ cohortId, trackId: fromTrackId })
        .returning({ fromLinkId: cohortTracks.id });
      const [{ toLinkId }] = await pg.db
        .insert(cohortTracks)
        .values({ cohortId, trackId: toTrackId })
        .returning({ toLinkId: cohortTracks.id });
      await pg.db.insert(cohortMembers).values({
        cohortId,
        userId,
        role: CohortRole.Student,
        status: StudentStatus.Active,
        cohortTrackId: fromLinkId,
      });
      return { userId, cohortId, fromLinkId, toTrackId, toLinkId };
    }

    it('applies one of the two and refuses the other as a conflict', async () => {
      const wrong: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { userId, cohortId, fromLinkId, toTrackId, toLinkId } =
          await studentOnOneOfTwoTracks();

        const [move, detach] = await Promise.allSettled([
          members.moveMemberTrack(cohortId, userId, toTrackId, audit),
          cohortsService.detachTrack(cohortId, toTrackId, audit),
        ]);

        const [member] = await pg.db
          .select({ cohortTrackId: cohortMembers.cohortTrackId })
          .from(cohortMembers)
          .where(eq(cohortMembers.userId, userId));
        const outcome = (result: PromiseSettledResult<unknown>) =>
          result.status === 'fulfilled'
            ? 'applied'
            : result.reason instanceof CohortConflictException
              ? 'conflict'
              : `failed: ${String(result.reason)}`;
        const moved = `${outcome(move)}/${outcome(detach)}`;

        const fine =
          (moved === 'applied/conflict' && member.cohortTrackId === toLinkId) ||
          (moved === 'conflict/applied' && member.cohortTrackId === fromLinkId);
        if (!fine) {
          wrong.push(
            `round ${round}: move/detach ${moved}, student on ${member.cohortTrackId}`,
          );
        }
      }

      expect(wrong).toEqual([]);
    }, 120_000);
  },
);
