import {
  RecordingRefusedError,
  spaceRoomName,
  type RecordingEvent,
} from '@campus/media';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaceMemberships,
  spaces,
} from '../maps/schema.js';
import { SystemRole, users } from '../users/schema.js';
import {
  RecordingConflictException,
  RecordingForbiddenException,
  RecordingNotConfiguredException,
  RecordingNotFoundException,
  RecordingUnavailableException,
} from './calls.exceptions.js';
import type { RecordingMedia } from './recording-media.js';
import { RecordingsService, START_SETTLE_MS } from './recordings.service.js';
import { RecordingStatus, recordings, sessions } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const db = drizzle(new PGlite());
const logger = { setContext: () => undefined, warn: () => undefined };
const NOW = new Date('2026-11-12T10:00:00.000Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let media: RecordingMedia & {
  started: { room: string; fileKey: string }[];
  stopped: string[];
  /** LiveKit says no. */
  refuse: boolean;
  /** LiveKit starts it, and its answer is lost. */
  loseAnswer: boolean;
  /** LiveKit gets the start and records nothing; its answer is lost. */
  dropStart: boolean;
  /** The run LiveKit says it records. */
  roomId: string | null;
  known: Map<string, RecordingEvent>;
};
let service: RecordingsService;
let cohortId: string;
let classroom: string;
let library: string;
let lab: string;
let professor: string;
let guest: string;
let admin: string;

async function person(email: string, systemRole = SystemRole.User) {
  const [user] = await db
    .insert(users)
    .values({ email, systemRole })
    .returning();
  return user.id;
}

async function openCall(spaceId: string) {
  await db.insert(sessions).values({
    cohortId,
    spaceId,
    providerRoomId: `RM_${spaceId}`,
    openedAt: NOW,
  });
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate recordings, session_participants, sessions, space_memberships, cohort_members, spaces, maps, cohorts, users cascade`,
  );
  media = {
    started: [],
    stopped: [],
    refuse: false,
    loseAnswer: false,
    dropStart: false,
    roomId: null,
    known: new Map(),
    async start(room, fileKey) {
      if (this.refuse) {
        throw new RecordingRefusedError('egress limit reached', 412);
      }
      if (this.dropStart) throw new Error('fetch failed');
      this.started.push({ room, fileKey });
      const egressId = `EG_${this.started.length}`;
      this.known.set(fileKey, {
        kind: 'recording_updated',
        egressId,
        room,
        roomId: this.roomId,
        fileKey,
        state: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        sizeBytes: null,
        error: null,
      });
      if (this.loseAnswer) throw new Error('fetch failed');
      return { egressId, roomId: this.roomId };
    },
    async stop(egressId) {
      this.stopped.push(egressId);
    },
    async find(_room, fileKey) {
      return this.known.get(fileKey) ?? null;
    },
  };
  service = new RecordingsService(db as never, media, logger as never);

  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus' })
    .returning();
  const space = (key: string, access: SpaceAccess) =>
    db
      .insert(spaces)
      .values({
        mapId: map.id,
        key,
        name: key,
        kind: SpaceKind.Classroom,
        audioMode: AudioMode.Boundary,
        access,
      })
      .returning()
      .then(([row]) => row.id);
  classroom = await space('classroom', SpaceAccess.Designated);
  library = await space('library', SpaceAccess.Normal);
  lab = await space('lab', SpaceAccess.Designated);
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
    .returning();
  cohortId = cohort.id;

  professor = await person('prof@campus.local');
  guest = await person('guest@campus.local');
  admin = await person('admin@campus.local', SystemRole.Admin);
  await db.insert(cohortMembers).values([
    { cohortId, userId: professor, role: CohortRole.Professor },
    {
      cohortId,
      userId: guest,
      role: CohortRole.Guest,
      accessExpiresAt: later(24 * 60),
    },
  ]);
  await db.insert(spaceMemberships).values({
    spaceId: classroom,
    userId: professor,
    validFrom: later(-60),
  });
});

const rows = () => db.select().from(recordings);

describe('starting a recording', () => {
  it('records the space’s call into a file of its own, and keeps LiveKit’s id', async () => {
    await openCall(classroom);

    const row = await service.start(professor, cohortId, classroom, NOW);

    expect(media.started).toEqual([
      {
        room: spaceRoomName({ cohortId, spaceId: classroom }),
        fileKey: `cohorts/${cohortId}/spaces/${classroom}/${row.id}.mp4`,
      },
    ]);
    expect(row).toMatchObject({
      status: RecordingStatus.Starting,
      startedBy: professor,
      providerEgressId: 'EG_1',
    });
  });

  it('lets admins record any space, and refuses anyone who is not staff', async () => {
    await openCall(classroom);
    await openCall(lab);
    await openCall(library);

    await expect(
      service.start(guest, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingForbiddenException);
    await expect(
      service.start(admin, cohortId, lab, NOW),
    ).resolves.toMatchObject({ startedBy: admin });
    await expect(
      service.start(admin, cohortId, library, NOW),
    ).resolves.toMatchObject({ startedBy: admin });
  });

  it('lets professors and mentors record only a designated space whose list names them', async () => {
    await openCall(lab);
    await openCall(library);

    await expect(service.start(professor, cohortId, lab, NOW)).rejects.toThrow(
      RecordingForbiddenException,
    );
    await expect(
      service.start(professor, cohortId, library, NOW),
    ).rejects.toThrow(RecordingForbiddenException);
  });

  it('stops counting a list entry once it has ended', async () => {
    await openCall(classroom);
    await db
      .update(spaceMemberships)
      .set({ validTo: later(-1) })
      .where(eq(spaceMemberships.spaceId, classroom));

    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingForbiddenException);
  });

  it('needs a call going on, and records it once at a time', async () => {
    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingConflictException);

    await openCall(classroom);
    await service.start(professor, cohortId, classroom, NOW);

    await expect(
      service.start(admin, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingConflictException);
    expect(media.started).toHaveLength(1);
  });

  it('marks it failed when LiveKit will not start it, and lets staff try again', async () => {
    await openCall(classroom);
    media.refuse = true;

    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingUnavailableException);
    expect(await rows()).toMatchObject([
      { status: RecordingStatus.Failed, error: 'egress limit reached' },
    ]);

    media.refuse = false;
    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).resolves.toMatchObject({ status: RecordingStatus.Starting });
  });

  it('keeps a recording whose start LiveKit took but whose answer was lost', async () => {
    await openCall(classroom);
    media.loseAnswer = true;

    const row = await service.start(professor, cohortId, classroom, NOW);

    expect(row).toMatchObject({
      status: RecordingStatus.Starting,
      providerEgressId: 'EG_1',
    });
    await expect(
      service.start(admin, cohortId, classroom, later(1)),
    ).rejects.toThrow(RecordingConflictException);
    await service.stop(admin, cohortId, classroom, later(5));
    expect(media.stopped).toEqual(['EG_1']);
  });

  it('holds the call after an unanswered start until LiveKit is asked, then lets go of one it never started', async () => {
    await openCall(classroom);
    media.dropStart = true;

    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingUnavailableException);
    expect(await rows()).toMatchObject([
      { status: RecordingStatus.Starting, providerEgressId: null },
    ]);
    media.dropStart = false;
    await expect(
      service.start(professor, cohortId, classroom, later(1)),
    ).rejects.toThrow(RecordingConflictException);
    expect(media.started).toEqual([]);

    const settled = new Date(NOW.getTime() + START_SETTLE_MS);
    await expect(
      service.start(professor, cohortId, classroom, settled),
    ).resolves.toMatchObject({ providerEgressId: 'EG_1' });
    expect(await rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: RecordingStatus.Failed,
          error: 'LiveKit has no record of it',
        }),
      ]),
    );
  });

  it('lets a late webhook take up a start whose answer was lost', async () => {
    await openCall(classroom);
    media.dropStart = true;
    await expect(
      service.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingUnavailableException);
    const [row] = await rows();

    await service.record(
      {
        kind: 'recording_updated',
        egressId: 'EG_9',
        room: spaceRoomName({ cohortId, spaceId: classroom }),
        roomId: `RM_${classroom}`,
        fileKey: row.fileKey,
        state: 'active',
        startedAt: later(1),
        endedAt: null,
        durationMs: null,
        sizeBytes: null,
        error: null,
      },
      later(1),
    );

    await service.stop(professor, cohortId, classroom, later(5));
    expect(media.stopped).toEqual(['EG_9']);
  });

  it('follows the call into the run LiveKit records, when it turned over as the recording started', async () => {
    await openCall(classroom);
    const [before] = await db.select().from(sessions);
    await db
      .update(sessions)
      .set({ closedAt: NOW })
      .where(eq(sessions.id, before.id));
    const [after] = await db
      .insert(sessions)
      .values({
        cohortId,
        spaceId: classroom,
        providerRoomId: 'RM_next',
        openedAt: NOW,
      })
      .returning();
    // The start saw the old run; LiveKit recorded the new one.
    const [row] = await db
      .insert(recordings)
      .values({
        sessionId: before.id,
        startedBy: professor,
        fileKey: 'cohorts/x/spaces/y/z.mp4',
        providerEgressId: 'EG_7',
      })
      .returning();
    media.known.set(row.fileKey, {
      kind: 'recording_updated',
      egressId: 'EG_7',
      room: spaceRoomName({ cohortId, spaceId: classroom }),
      roomId: 'RM_next',
      fileKey: row.fileKey,
      state: 'active',
      startedAt: NOW,
      endedAt: null,
      durationMs: null,
      sizeBytes: null,
      error: null,
    });

    await expect(
      service.start(admin, cohortId, classroom, later(1)),
    ).rejects.toThrow(RecordingConflictException);
    expect(await rows()).toMatchObject([
      { id: row.id, sessionId: after.id, status: RecordingStatus.Active },
    ]);

    await service.stop(admin, cohortId, classroom, later(5));
    expect(media.stopped).toEqual(['EG_7']);
  });

  it('moves a recording to the run LiveKit names when it starts', async () => {
    await db.insert(sessions).values({
      cohortId,
      spaceId: classroom,
      providerRoomId: 'RM_old',
      openedAt: later(-30),
      closedAt: later(-1),
    });
    await openCall(classroom);
    const [old] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.providerRoomId, 'RM_old'));
    const [current] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.providerRoomId, `RM_${classroom}`));
    media.roomId = 'RM_old';

    const row = await service.start(professor, cohortId, classroom, NOW);

    expect(row.sessionId).toBe(old.id);
    expect(current.id).not.toBe(old.id);
    // The recording's run is closed; stop still reaches it.
    await service.stop(professor, cohortId, classroom, later(5));
    expect(media.stopped).toEqual(['EG_1']);
  });

  it('answers 503 where recording is not configured', async () => {
    await openCall(classroom);
    const unconfigured = new RecordingsService(
      db as never,
      null,
      logger as never,
    );

    await expect(
      unconfigured.start(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingNotConfiguredException);
  });
});

describe('stopping a recording', () => {
  it('stops the space’s recording and says who stopped it', async () => {
    await openCall(classroom);
    await service.start(professor, cohortId, classroom, NOW);

    const row = await service.stop(admin, cohortId, classroom, later(5));

    expect(media.stopped).toEqual(['EG_1']);
    expect(row.stoppedBy).toBe(admin);
  });

  it('finds nothing to stop where nothing is recording', async () => {
    await openCall(classroom);

    await expect(
      service.stop(professor, cohortId, classroom, NOW),
    ).rejects.toThrow(RecordingNotFoundException);
  });

  it('refuses anyone who is not staff', async () => {
    await openCall(classroom);
    await service.start(professor, cohortId, classroom, NOW);

    await expect(service.stop(guest, cohortId, classroom, NOW)).rejects.toThrow(
      RecordingForbiddenException,
    );
    expect(media.stopped).toEqual([]);
  });
});

describe('what LiveKit says of a recording', () => {
  const event = (
    over: Partial<RecordingEvent> & Pick<RecordingEvent, 'state'>,
  ): RecordingEvent => ({
    kind: 'recording_updated',
    egressId: 'EG_1',
    room: spaceRoomName({ cohortId, spaceId: classroom }),
    roomId: null,
    fileKey: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    sizeBytes: null,
    error: null,
    ...over,
  });

  beforeEach(async () => {
    await openCall(classroom);
  });

  it('records it under way, then saved with its length and size', async () => {
    await service.start(professor, cohortId, classroom, NOW);

    await service.record(
      event({ state: 'active', startedAt: later(1) }),
      later(1),
    );
    await service.record(
      event({
        state: 'complete',
        endedAt: later(61),
        durationMs: 3_600_000,
        sizeBytes: 1_000_000_000,
      }),
      later(62),
    );

    expect(await rows()).toMatchObject([
      {
        status: RecordingStatus.Complete,
        startedAt: later(1),
        endedAt: later(61),
        durationMs: 3_600_000,
        sizeBytes: 1_000_000_000,
      },
    ]);
  });

  it('keeps a finished recording finished, whatever arrives late', async () => {
    await service.start(professor, cohortId, classroom, NOW);

    await service.record(
      event({ state: 'complete', startedAt: later(1), endedAt: later(30) }),
      later(30),
    );
    await service.record(
      event({ state: 'active', startedAt: later(1) }),
      later(31),
    );

    expect(await rows()).toMatchObject([
      { status: RecordingStatus.Complete, endedAt: later(30) },
    ]);
  });

  it('finds the recording by its file before LiveKit’s id is saved', async () => {
    const [session] = await db.select().from(sessions);
    const [row] = await db
      .insert(recordings)
      .values({
        sessionId: session.id,
        startedBy: professor,
        fileKey: 'cohorts/x/spaces/y/z.mp4',
      })
      .returning();

    await service.record(
      event({ state: 'active', fileKey: 'cohorts/x/spaces/y/z.mp4' }),
      later(1),
    );

    const [after] = await db
      .select()
      .from(recordings)
      .where(eq(recordings.id, row.id));
    expect(after).toMatchObject({
      providerEgressId: 'EG_1',
      status: RecordingStatus.Active,
    });
  });

  it('ignores a recording nothing here started', async () => {
    await expect(
      service.record(event({ state: 'active' }), later(1)),
    ).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
  });
});
