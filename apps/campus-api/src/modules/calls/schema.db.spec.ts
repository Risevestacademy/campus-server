import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import { AudioMode, SpaceAccess, maps, spaces } from '../maps/schema.js';
import { users } from '../users/schema.js';
import { MediaProvider, sessionParticipants, sessions } from './schema.js';

/**
 * The rules about calls live in the migration, so they are tested there:
 * against PGlite with the committed migrations applied.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite());

/** Asserts the write failed, and that the error names what refused it. */
async function expectViolation(
  write: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await write;
  } catch (caught) {
    error = caught;
  }

  const detail =
    error instanceof Error
      ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}`
      : String(error);

  expect(
    error,
    `expected a violation of ${constraint}, but the write succeeded`,
  ).toBeDefined();
  expect(detail).toContain(constraint);
}

const NOBODY = '00000000-0000-4000-8000-000000000000';

let mapId: string;
let spaceId: string;
let userId: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate session_participants, sessions, spaces, maps, users cascade`,
  );
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus', isEntry: true })
    .returning();
  mapId = map.id;
  [{ id: spaceId }] = await space('library');
  [{ id: userId }] = await db
    .insert(users)
    .values({ email: 'ada@campus.local' })
    .returning();
});

function space(key: string) {
  return db
    .insert(spaces)
    .values({
      mapId,
      key,
      name: key,
      audioMode: AudioMode.Boundary,
      access: SpaceAccess.Open,
    })
    .returning();
}

function open(overrides: Partial<typeof sessions.$inferInsert> = {}) {
  return db
    .insert(sessions)
    .values({ spaceId, providerRoomId: `room-${Math.random()}`, ...overrides })
    .returning();
}

const close = (id: string) =>
  db
    .update(sessions)
    .set({ closedAt: new Date() })
    .where(sql`${sessions.id} = ${id}`);

describe('sessions', () => {
  it('opens on LiveKit, now, and stays open until closed', async () => {
    const [row] = await open();

    expect(row.provider).toBe(MediaProvider.LiveKit);
    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.closedAt).toBeNull();
  });

  it('has at most one open session per space', async () => {
    await open();

    await expectViolation(open(), 'sessions_one_open_per_space');
  });

  it('lets each space have its own open session', async () => {
    await open();
    const [{ id: otherSpaceId }] = await space('annex');

    await expect(open({ spaceId: otherSpaceId })).resolves.toBeDefined();
  });

  /** The rule is about open ones: a space's history holds any number. */
  it('opens a new session once the last one is closed', async () => {
    const [first] = await open();
    await close(first.id);
    const [second] = await open();
    await close(second.id);

    await expect(open()).resolves.toBeDefined();
  });

  it('is held in a space that exists', async () => {
    await expectViolation(
      open({ spaceId: NOBODY }),
      'sessions_space_id_spaces_id_fk',
    );
  });
});

describe('session_participants', () => {
  let sessionId: string;

  beforeEach(async () => {
    [{ id: sessionId }] = await open();
  });

  const join = (
    overrides: Partial<typeof sessionParticipants.$inferInsert> = {},
  ) =>
    db
      .insert(sessionParticipants)
      .values({ sessionId, userId, ...overrides })
      .returning();

  it('records somebody joining with video off unless they turned it on', async () => {
    const [quiet] = await join();
    const [onCamera] = await join({ videoEnabled: true });

    expect(quiet.videoEnabled).toBe(false);
    expect(onCamera.videoEnabled).toBe(true);
    expect(quiet.leftAt).toBeNull();
  });

  /** Unknown is not a third answer: a row that cannot say is off. */
  it('refuses a participant whose video is neither on nor off', async () => {
    await expectViolation(
      db.execute(
        sql`insert into session_participants (session_id, user_id, video_enabled) values (${sessionId}, ${userId}, null)`,
      ),
      'column "video_enabled" of relation "session_participants" violates not-null constraint',
    );
  });

  it('points at a session and a person that exist', async () => {
    await expectViolation(
      join({ sessionId: NOBODY }),
      'session_participants_session_id_sessions_id_fk',
    );
    await expectViolation(
      join({ userId: NOBODY }),
      'session_participants_user_id_users_id_fk',
    );
  });
});
