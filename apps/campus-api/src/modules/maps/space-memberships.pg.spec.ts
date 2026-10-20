import { eq } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { SystemRole, users } from '../users/schema.js';
import { SpaceMembershipAlreadyLiveException } from './maps.exceptions.js';
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
          access: SpaceAccess.Invite,
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
