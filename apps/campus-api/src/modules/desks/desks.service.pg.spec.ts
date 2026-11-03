import { and, eq, isNull } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps } from '../maps/schema.js';
import { SystemRole, UserStatus, users } from '../users/schema.js';
import {
  DeskConflictException,
  DeskForbiddenException,
  DeskNotFoundException,
} from './desks.exceptions.js';
import { DesksService } from './desks.service.js';
import { endDeskClaims } from './end-claims.js';
import { DeskReleaseReason, deskClaims, desks } from './schema.js';

/**
 * Claims against a real server: the times a release writes go through
 * postgres.js, which PGlite does not, and the locks a claim takes only mean
 * something with two connections. Each race holds the other side's
 * transaction open until the claim is seen waiting, then lets it go.
 */
describe.skipIf(!REAL_POSTGRES_URL)('DesksService on real Postgres', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let service: DesksService;
  let mapId: string;

  beforeAll(async () => {
    pg = connectRealPostgres();
    service = new DesksService(pg.db as never);
    const [map] = await pg.db
      .insert(maps)
      .values({ key: `desks-${unique()}`, name: 'Desks' })
      .returning();
    mapId = map.id;
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

  /** A cohort of two mentors and two fresh desks, under keys nobody else uses. */
  const setting = async () => {
    const tag = unique();
    const [cohort] = await pg.db
      .insert(cohorts)
      .values({ name: 'Desks', code: `D${tag}`.toUpperCase().slice(0, 32) })
      .returning();
    const people = await pg.db
      .insert(users)
      .values([
        { email: `desk-a-${tag}@campus.local` },
        { email: `desk-b-${tag}@campus.local` },
      ])
      .returning();
    await pg.db.insert(cohortMembers).values(
      people.map((person) => ({
        cohortId: cohort.id,
        userId: person.id,
        role: CohortRole.Mentor,
      })),
    );
    const made = await pg.db
      .insert(desks)
      .values([
        { mapId, key: `desk-1-${tag}` },
        { mapId, key: `desk-2-${tag}` },
      ])
      .returning();
    const [first, second]: AuthenticatedUser[] = people.map((person) => ({
      id: person.id,
      email: person.email,
      systemRole: SystemRole.User,
    }));
    return { cohortId: cohort.id, first, second, desks: made };
  };

  const openClaims = (deskId: string) =>
    pg.db
      .select()
      .from(deskClaims)
      .where(and(eq(deskClaims.deskId, deskId), isNull(deskClaims.releasedAt)));

  it('claims, moves and lets go', async () => {
    const { cohortId, first, desks: made } = await setting();

    await service.claim(first, cohortId, made[0].key);
    await service.claim(first, cohortId, made[1].key);
    await service.release(first, cohortId, made[1].key, {
      actorUserId: first.id,
    });

    const rows = await pg.db
      .select({ deskId: deskClaims.deskId, reason: deskClaims.releaseReason })
      .from(deskClaims)
      .where(eq(deskClaims.cohortId, cohortId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reason === DeskReleaseReason.Released)).toBe(
      true,
    );
  }, 30_000);

  it('gives a desk claimed twice at once to one of them, and refuses the other', async () => {
    const { cohortId, first, second, desks: made } = await setting();
    const gate = deferred();
    const locked = deferred();
    const holding = pg.db.transaction(async (tx) => {
      await tx
        .insert(deskClaims)
        .values({ deskId: made[0].id, cohortId, userId: second.id });
      locked.resolve();
      await gate.promise;
    });

    await locked.promise;
    const racing = service.claim(first, cohortId, made[0].key);
    expect(await within(racing, 1_000)).toMatchObject({
      settled: 'still waiting',
    });

    gate.resolve();
    await holding;
    expect(await within(racing, 5_000)).toMatchObject({
      settled: 'rejected',
      error: expect.any(DeskConflictException),
    });
    await expect(openClaims(made[0].id)).resolves.toEqual([
      expect.objectContaining({ userId: second.id }),
    ]);
  }, 30_000);

  it('refuses a claim whose membership ends while it waits', async () => {
    const { cohortId, first, desks: made } = await setting();
    const gate = deferred();
    const locked = deferred();
    const now = new Date();
    const ending = pg.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(cohortMembers)
        .where(
          and(
            eq(cohortMembers.cohortId, cohortId),
            eq(cohortMembers.userId, first.id),
          ),
        )
        .for('update');
      locked.resolve();
      await gate.promise;
      await tx
        .update(cohortMembers)
        .set({ leftAt: now })
        .where(eq(cohortMembers.id, member.id));
      await endDeskClaims(
        tx,
        and(eq(deskClaims.cohortId, cohortId), eq(deskClaims.userId, first.id)),
        DeskReleaseReason.EnrolmentEnded,
        now,
      );
    });

    await locked.promise;
    const racing = service.claim(first, cohortId, made[0].key);
    expect(await within(racing, 1_000)).toMatchObject({
      settled: 'still waiting',
    });

    gate.resolve();
    await ending;
    expect(await within(racing, 5_000)).toMatchObject({
      settled: 'rejected',
      error: expect.any(DeskForbiddenException),
    });
    await expect(openClaims(made[0].id)).resolves.toEqual([]);
  }, 30_000);

  it('refuses a claim on a desk the map sync retires while it waits', async () => {
    const { cohortId, first, desks: made } = await setting();
    const gate = deferred();
    const locked = deferred();
    const retiring = pg.db.transaction(async (tx) => {
      await tx
        .select()
        .from(desks)
        .where(eq(desks.id, made[0].id))
        .for('update');
      locked.resolve();
      await gate.promise;
      await tx
        .update(desks)
        .set({ retiredAt: new Date() })
        .where(eq(desks.id, made[0].id));
    });

    await locked.promise;
    const racing = service.claim(first, cohortId, made[0].key);
    expect(await within(racing, 1_000)).toMatchObject({
      settled: 'still waiting',
    });

    gate.resolve();
    await retiring;
    expect(await within(racing, 5_000)).toMatchObject({
      settled: 'rejected',
      error: expect.any(DeskNotFoundException),
    });
    await expect(openClaims(made[0].id)).resolves.toEqual([]);
  }, 30_000);

  it('refuses a claim whose account is suspended while it waits', async () => {
    const { cohortId, first, desks: made } = await setting();
    const gate = deferred();
    const locked = deferred();
    const suspending = pg.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, first.id)).for('update');
      locked.resolve();
      await gate.promise;
      await tx
        .update(users)
        .set({ status: UserStatus.Suspended })
        .where(eq(users.id, first.id));
      await endDeskClaims(
        tx,
        eq(deskClaims.userId, first.id),
        DeskReleaseReason.AccountSuspended,
        new Date(),
      );
    });

    await locked.promise;
    const racing = service.claim(first, cohortId, made[0].key);
    expect(await within(racing, 1_000)).toMatchObject({
      settled: 'still waiting',
    });

    gate.resolve();
    await suspending;
    expect(await within(racing, 5_000)).toMatchObject({
      settled: 'rejected',
      error: expect.any(DeskForbiddenException),
    });
    await expect(openClaims(made[0].id)).resolves.toEqual([]);
  }, 30_000);
});
