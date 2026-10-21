import { spaceRoomName, type CallEvent } from '@campus/media';
import { PGlite } from '@electric-sql/pglite';
import { asc, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { cohorts } from '../cohorts/schema.js';
import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { users } from '../users/schema.js';
import { CallsService } from './calls.service.js';
import { sessionParticipants, sessions } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const service = new CallsService(db as never);

const T0 = new Date('2026-10-21T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let room: string;
let userId: string;
let identity: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate session_participants, sessions, spaces, maps, cohorts, users cascade`,
  );
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus' })
    .returning();
  const [space] = await db
    .insert(spaces)
    .values({
      mapId: map.id,
      key: 'library',
      name: 'Library',
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Normal,
    })
    .returning();
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ email: 'ada@campus.local' })
    .returning();
  room = spaceRoomName({ cohortId: cohort.id, spaceId: space.id });
  userId = user.id;
  identity = `${userId}:first`;
});

const record = (event: CallEvent, minutes: number) =>
  service.record(event, at(minutes));
const RUN = 'RM_1';
const joined = (who = identity, roomId = RUN): CallEvent => ({
  kind: 'participant_joined',
  room,
  roomId,
  identity: who,
});
const left = (who = identity, roomId = RUN): CallEvent => ({
  kind: 'participant_left',
  room,
  roomId,
  identity: who,
});
const started = (roomId = RUN): CallEvent => ({
  kind: 'room_started',
  room,
  roomId,
});
const finished = (roomId = RUN): CallEvent => ({
  kind: 'room_finished',
  room,
  roomId,
});

const calls = () =>
  db
    .select({ openedAt: sessions.openedAt, closedAt: sessions.closedAt })
    .from(sessions);
const participants = () =>
  db
    .select({
      providerIdentity: sessionParticipants.providerIdentity,
      joinedAt: sessionParticipants.joinedAt,
      leftAt: sessionParticipants.leftAt,
      videoEnabled: sessionParticipants.videoEnabled,
    })
    .from(sessionParticipants)
    .orderBy(asc(sessionParticipants.joinedAt));

describe('recording a space’s call', () => {
  it('opens a call when its room starts, and once only', async () => {
    await record(started(), 0);
    await record(started(), 1);

    await expect(calls()).resolves.toEqual([
      { openedAt: at(0), closedAt: null },
    ]);
  });

  it('records who joins and leaves, opening the call if its start was missed', async () => {
    await record(joined(), 0);
    await record(left(), 5);

    await expect(calls()).resolves.toEqual([
      { openedAt: at(0), closedAt: null },
    ]);
    await expect(participants()).resolves.toEqual([
      {
        providerIdentity: identity,
        joinedAt: at(0),
        leftAt: at(5),
        videoEnabled: false,
      },
    ]);
  });

  it('applies a retried join or leave once', async () => {
    await record(joined(), 0);
    await record(joined(), 1);
    await record(left(), 5);
    await record(left(), 6);

    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ joinedAt: at(0), leftAt: at(5) }),
    ]);
  });

  it('closes the old row when somebody is back under a new identity before their leave arrives', async () => {
    const again = `${userId}:second`;
    await record(joined(), 0);
    await record(joined(again), 3);
    await record(left(), 4);

    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ providerIdentity: identity, leftAt: at(3) }),
      expect.objectContaining({ providerIdentity: again, leftAt: null }),
    ]);
  });

  it('records that somebody turned their camera on, and not a microphone', async () => {
    await record(joined(), 0);
    await record(
      { kind: 'track_published', room, roomId: RUN, identity, video: false },
      1,
    );
    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ videoEnabled: false }),
    ]);

    await record(
      { kind: 'track_published', room, roomId: RUN, identity, video: true },
      2,
    );
    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ videoEnabled: true }),
    ]);
  });

  it('closes the call and everybody still in it when the room finishes', async () => {
    await record(joined(), 0);
    await record(finished(), 10);

    await expect(calls()).resolves.toEqual([
      { openedAt: at(0), closedAt: at(10) },
    ]);
    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ leftAt: at(10) }),
    ]);
  });

  it('does not reopen a row when a join is retried after the leave', async () => {
    await record(joined(), 0);
    await record(left(), 5);
    await record(joined(), 6);

    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ joinedAt: at(0), leftAt: at(5) }),
    ]);
  });

  it('ignores a join that arrives after its run has finished', async () => {
    await record(started(), 0);
    await record(finished(), 10);
    await record(joined(), 5);

    await expect(participants()).resolves.toEqual([]);
  });

  it('closes an unfinished run when the room runs again, and drops late news of the old run', async () => {
    await record(started('RM_1'), 0);
    await record(joined(identity, 'RM_1'), 1);
    await record(started('RM_2'), 20);
    await record(finished('RM_1'), 30);
    await record(joined(`${userId}:late`, 'RM_1'), 2);

    await expect(calls()).resolves.toEqual([
      { openedAt: at(0), closedAt: at(20) },
      { openedAt: at(20), closedAt: null },
    ]);
    await expect(participants()).resolves.toEqual([
      expect.objectContaining({ providerIdentity: identity, leftAt: at(20) }),
    ]);
  });

  it('records nobody for an identity that names no user', async () => {
    await record(joined('somebody'), 0);

    await expect(participants()).resolves.toEqual([]);
  });

  it('ignores a room that is not a space’s call, and a cohort that is gone', async () => {
    await record(
      { kind: 'room_started', room: 'connection-check-1', roomId: 'RM_9' },
      0,
    );
    await record(
      {
        kind: 'room_started',
        roomId: 'RM_8',
        room: spaceRoomName({
          cohortId: '99999999-9999-4999-8999-999999999999',
          spaceId: '99999999-9999-4999-8999-999999999999',
        }),
      },
      0,
    );

    await expect(calls()).resolves.toEqual([]);
  });
});
