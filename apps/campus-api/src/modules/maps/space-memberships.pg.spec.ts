import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { CohortConflictException } from '../cohorts/cohorts.exceptions.js';
import { CohortsService } from '../cohorts/cohorts.service.js';
import { cohortTracks, cohorts } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import {
  SpaceMembershipAlreadyLiveException,
  SpaceMembershipSubjectNotFoundException,
} from './maps.exceptions.js';
import {
  AudioMode,
  SpaceAccess,
  maps,
  spaceMemberships,
  spaces,
} from './schema.js';
import { SpaceMembershipsService } from './space-memberships.service.js';

/**
 * What the space row lock is for. "A grant that is still live" is a question
 * about now, and a partial unique index may only name immutable conditions —
 * `now()` is refused in one — so the database cannot hold the one-grant rule
 * by itself. The service holds it by checking under the space's lock: two
 * grants for one space take turns, so the second sees the first.
 *
 * Made deterministic rather than raced: another transaction takes that lock,
 * writes a live grant to the same person, and holds both open until the test
 * lets it go. The grant that was waiting must then arrive at a duplicate —
 * without the lock its check would have run first, found nothing, and let
 * both in.
 *
 * See real-postgres.ts for why this cannot run on PGlite: one connection
 * never overlaps two transactions, so a lock passes there whether or not it
 * is there.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'SpaceMembershipsService, two grants at once',
  () => {
    let pg: ReturnType<typeof connectRealPostgres>;
    let service: SpaceMembershipsService;
    let actor: { actorUserId: string; correlationId: string };
    let spaceId: string;
    let memberId: string;

    beforeAll(async () => {
      pg = connectRealPostgres();
      service = new SpaceMembershipsService(pg.db as never);

      const tag = unique();
      const [admin] = await pg.db
        .insert(users)
        .values({
          email: `space-grants-${tag}@campus.local`,
          systemRole: SystemRole.Admin,
        })
        .returning();
      const [member] = await pg.db
        .insert(users)
        .values({ email: `space-member-${tag}@campus.local` })
        .returning();
      actor = { actorUserId: admin.id, correlationId: 'req-1' };
      memberId = member.id;

      const [map] = await pg.db
        .insert(maps)
        .values({ key: `space-grants-${tag}`, name: 'Space Grants' })
        .returning();
      const [room] = await pg.db
        .insert(spaces)
        .values({
          mapId: map.id,
          key: 'pod',
          name: 'Pod',
          audioMode: AudioMode.Proximity,
          access: SpaceAccess.Designated,
        })
        .returning();
      spaceId = room.id;
    });

    afterAll(async () => {
      await pg.close();
    });

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };

    /** Settles to what `task` gave, or 'still waiting' after `ms`. */
    const within = <T>(task: Promise<T>, ms: number) =>
      Promise.race([
        task.then(
          (value) => ({ settled: 'resolved' as const, value }),
          (error: unknown) => ({ settled: 'rejected' as const, error }),
        ),
        new Promise<{ settled: 'still waiting' }>((done) =>
          setTimeout(() => done({ settled: 'still waiting' }), ms),
        ),
      ]);

    it('makes the second grant wait, then refuse it as a duplicate', async () => {
      const gate = deferred();
      // The other grant, mid-transaction: lock the space, write a live grant
      // to the same person, and hold both until the test lets go.
      const holding = pg.db.transaction(async (tx) => {
        await tx
          .select()
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .for('update');
        await gate.promise;
        await tx.insert(spaceMemberships).values({
          spaceId,
          userId: memberId,
          grantedBy: actor.actorUserId,
          // Live at any instant the waiting grant might have read: started
          // a minute ago, no end.
          validFrom: new Date(Date.now() - 60_000),
          validTo: null,
        });
      });

      const racing = service.grant(spaceId, { userId: memberId }, actor);
      // Waiting on the lock, not settled: the other transaction holds it.
      const outcome = await within(racing, 1_000);
      expect(outcome).toMatchObject({ settled: 'still waiting' });

      gate.resolve();
      await holding;
      // Now it proceeds — and the check it runs finds the committed grant.
      await expect(racing).rejects.toBeInstanceOf(
        SpaceMembershipAlreadyLiveException,
      );

      const grants = await pg.db
        .select()
        .from(spaceMemberships)
        .where(eq(spaceMemberships.spaceId, spaceId));
      // The loser wrote nothing: its transaction refused and rolled back whole.
      expect(grants).toHaveLength(1);
    }, 30_000);
  },
);

const ROUNDS = 40;

/**
 * What the lock on the cohort's link to a track is for, here. A grant to a
 * track reads that link and writes a row pointing at it; a detach looks for
 * grants on it, then deletes it. Unlocked, the detach can look before the
 * grant commits and delete after, and fail on the foreign key — reaching the
 * admin as a refusal about students and invites, which is not why — or the
 * grant can write after the link is gone, a 500. Locked, exactly one of the
 * two happens: the grant went first and the detach is refused for it, or
 * the detach went first and the grant finds no track.
 */
describe.skipIf(!REAL_POSTGRES_URL)(
  'SpaceMembershipsService, a track grant and a detach at once',
  () => {
    let pg: ReturnType<typeof connectRealPostgres>;
    let service: SpaceMembershipsService;
    let cohortsService: CohortsService;
    let spaceId: string;
    const audit = { actorUserId: null };

    beforeAll(async () => {
      pg = connectRealPostgres();
      service = new SpaceMembershipsService(pg.db as never);
      cohortsService = new CohortsService(pg.db as never);

      const tag = unique();
      const [map] = await pg.db
        .insert(maps)
        .values({ key: `track-grants-${tag}`, name: 'Track Grants' })
        .returning();
      const [room] = await pg.db
        .insert(spaces)
        .values({
          mapId: map.id,
          key: 'studio',
          name: 'Studio',
          audioMode: AudioMode.Proximity,
          access: SpaceAccess.Designated,
        })
        .returning();
      spaceId = room.id;
    });

    afterAll(async () => {
      await pg.close();
    });

    async function cohortRunningATrack() {
      const tag = unique();
      const code = (prefix: string) =>
        `${prefix}${tag}`.toUpperCase().slice(0, 32);
      const [cohort] = await pg.db
        .insert(cohorts)
        .values({ name: `Cohort ${tag}`, code: code('C') })
        .returning();
      const [track] = await pg.db
        .insert(tracks)
        .values({ name: `Track ${tag}`, code: code('T') })
        .returning();
      const [link] = await pg.db
        .insert(cohortTracks)
        .values({ cohortId: cohort.id, trackId: track.id })
        .returning();
      return { cohortId: cohort.id, trackId: track.id, linkId: link.id };
    }

    it('applies one of the two and refuses the other for the right reason', async () => {
      const wrong: string[] = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const { cohortId, trackId, linkId } = await cohortRunningATrack();

        const [granted, detached] = await Promise.allSettled([
          service.grant(spaceId, { cohortTrackId: linkId }, audit),
          cohortsService.detachTrack(cohortId, trackId, audit),
        ]);

        const grants = await pg.db
          .select()
          .from(spaceMemberships)
          .where(eq(spaceMemberships.cohortTrackId, linkId));
        const links = await pg.db
          .select()
          .from(cohortTracks)
          .where(eq(cohortTracks.id, linkId));
        const outcome = (result: PromiseSettledResult<unknown>) => {
          if (result.status === 'fulfilled') return 'applied';
          const reason = result.reason as Error;
          if (reason instanceof SpaceMembershipSubjectNotFoundException) {
            return 'no track';
          }
          if (
            reason instanceof CohortConflictException &&
            /access to a space/.test(reason.message)
          ) {
            return 'refused for the grant';
          }
          return `failed: ${String(reason)}`;
        };
        const both = `${outcome(granted)}/${outcome(detached)}`;

        const fine =
          (both === 'applied/refused for the grant' &&
            grants.length === 1 &&
            links.length === 1) ||
          (both === 'no track/applied' &&
            grants.length === 0 &&
            links.length === 0);
        if (!fine) {
          wrong.push(
            `round ${round}: grant/detach ${both}, ${grants.length} grants, ${links.length} links`,
          );
        }
      }

      expect(wrong).toEqual([]);
    }, 120_000);
  },
);
