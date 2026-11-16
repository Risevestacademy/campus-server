import { spaceRoomName, type CallEvent } from '@campus/media';
import { and, eq, isNull } from 'drizzle-orm';

import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { cohorts } from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { users } from '../users/schema.js';
import { CallsService } from './calls.service.js';
import { sessionParticipants, sessions } from './schema.js';

/**
 * What the lock on a run's session is for. LiveKit delivers a run's webhooks
 * as they come, several at once when a room fills. Each is applied under a
 * lock on its session, so they take turns: one session per run however
 * many first words of it arrive together, and one open row per person
 * however their joins overlap. PGlite runs one transaction at a time, so
 * only a real server can show it.
 */
describe.skipIf(!REAL_POSTGRES_URL)('CallsService, webhooks at once', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let service: CallsService;
  const logger = { setContext: () => undefined, warn: () => undefined };

  beforeAll(() => {
    pg = connectRealPostgres();
    service = new CallsService(pg.db as never, {} as never, logger as never);
  });

  afterAll(async () => {
    await pg.close();
  });

  async function aRoom(people: number) {
    const tag = unique();
    const [map] = await pg.db
      .insert(maps)
      .values({ key: `calls-${tag}`, name: 'Calls' })
      .returning();
    const [space] = await pg.db
      .insert(spaces)
      .values({
        mapId: map.id,
        key: 'room',
        name: 'Room',
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      })
      .returning();
    const [cohort] = await pg.db
      .insert(cohorts)
      .values({
        name: `Cohort ${tag}`,
        code: `C${tag}`.toUpperCase().slice(0, 32),
      })
      .returning();
    const userIds: string[] = [];
    for (let i = 0; i < people; i += 1) {
      const [user] = await pg.db
        .insert(users)
        .values({ email: `call-${i}-${tag}@campus.local` })
        .returning();
      userIds.push(user.id);
    }
    return {
      room: spaceRoomName({ cohortId: cohort.id, spaceId: space.id }),
      roomId: `RM_${tag}`,
      cohortId: cohort.id,
      userIds,
    };
  }

  const at = new Date('2026-10-21T09:00:00.000Z');
  const ROUNDS = 20;

  it('opens one session for a run, however many of its first events arrive together', async () => {
    const wrong: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const { room, roomId, cohortId, userIds } = await aRoom(6);
      const inRoom = { room, roomId, roomOpenedAt: at };

      const results = await Promise.allSettled([
        service.record({ kind: 'room_started', ...inRoom }, at),
        ...userIds.map((userId) =>
          service.record(
            {
              kind: 'participant_joined',
              ...inRoom,
              identity: `${userId}:a`,
              joinedAt: at,
            } satisfies CallEvent,
            at,
          ),
        ),
      ]);

      const failed = results.filter((r) => r.status === 'rejected').length;
      const runs = await pg.db
        .select()
        .from(sessions)
        .where(eq(sessions.cohortId, cohortId));
      const people =
        runs.length === 1
          ? await pg.db
              .select()
              .from(sessionParticipants)
              .where(eq(sessionParticipants.sessionId, runs[0].id))
          : [];
      if (failed > 0 || runs.length !== 1 || people.length !== userIds.length) {
        wrong.push(
          `round ${round}: ${failed} failed, ${runs.length} sessions, ${people.length} people`,
        );
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('keeps one open row for a person whose joins under two identities arrive together', async () => {
    const wrong: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const { room, roomId, userIds } = await aRoom(1);
      const [userId] = userIds;
      const inRoom = { room, roomId, roomOpenedAt: at };
      await service.record({ kind: 'room_started', ...inRoom }, at);

      const results = await Promise.allSettled(
        ['a', 'b'].map((suffix, i) =>
          service.record(
            {
              kind: 'participant_joined',
              ...inRoom,
              identity: `${userId}:${suffix}`,
              joinedAt: new Date(at.getTime() + i * 1000),
            },
            at,
          ),
        ),
      );

      const failed = results.filter((r) => r.status === 'rejected').length;
      const open = await pg.db
        .select()
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.userId, userId),
            isNull(sessionParticipants.leftAt),
          ),
        );
      if (failed > 0 || open.length !== 1) {
        wrong.push(`round ${round}: ${failed} failed, ${open.length} open`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
