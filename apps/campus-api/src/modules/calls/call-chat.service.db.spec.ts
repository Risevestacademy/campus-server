import { createTestAnalytics } from '@campus/analytics/testing';
import { spaceRoomName, type CallEvent } from '@campus/media';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import {
  AudioMode,
  SpaceAccess,
  SpaceKind,
  maps,
  spaces,
} from '../maps/schema.js';
import {
  MediaGoneException,
  MediaNotFoundException,
  UploadNotFoundException,
} from '../media/media.exceptions.js';
import { MediaService } from '../media/media.service.js';
import { MediaKind, MediaStatus, media } from '../media/schema.js';
import { memoryMediaStorage } from '../media/testing/memory-media-storage.js';
import { SystemRole, users } from '../users/schema.js';
import { CallChatService } from './call-chat.service.js';
import {
  CallChatForbiddenException,
  CallChatNotFoundException,
  NoOpenCallException,
} from './calls.exceptions.js';
import { CallsService } from './calls.service.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);
const DAY_MS = 24 * 60 * 60_000;
const db = drizzle(new PGlite(), { schema });
const { objects, storage, upload } = memoryMediaStorage();
const mediaService = new MediaService(
  db as never,
  storage,
  { register: () => undefined } as never,
  { setContext: () => undefined, error: () => undefined } as never,
);
const chat = new CallChatService(db as never, mediaService);
chat.onModuleInit();
const calls = new CallsService(
  db as never,
  {} as never,
  { setContext: () => undefined, warn: () => undefined } as never,
  chat,
  createTestAnalytics(),
);

let member: AuthenticatedUser;
let other: AuthenticatedUser;
let outsider: AuthenticatedUser;
let cohortId: string;
let spaceId: string;
let designatedId: string;
let room: string;

const person = (row: typeof users.$inferSelect): AuthenticatedUser => ({
  id: row.id,
  email: row.email,
  systemRole: row.systemRole,
});
const opened = (roomId: string) =>
  roomId === 'RM_2' ? new Date(Date.now() + 60_000) : new Date(0);
const event = (
  kind: 'room_started' | 'room_finished',
  roomId = 'RM_1',
): CallEvent => ({ kind, room, roomId, roomOpenedAt: opened(roomId) });
const file = (userId = member.id) =>
  upload(mediaService, userId, MediaKind.CallChatAttachment);
const send = (mediaId: string, userId = member.id, space = spaceId) =>
  chat.attach(userId, cohortId, space, mediaId, new Date());
const read = (viewer: AuthenticatedUser, mediaId: string) =>
  mediaService.readUrl(viewer, mediaId, new Date());
const statusOf = async (id: string) =>
  (await db.select().from(media).where(eq(media.id, id)))[0];

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
  await db.execute(
    sql`truncate call_chat_attachments, media, session_participants, sessions, spaces, maps, cohort_members, cohorts, users cascade`,
  );
  objects.clear();
  const [m, o, x] = await db
    .insert(users)
    .values([
      { email: 'member@campus.local' },
      { email: 'other@campus.local' },
      { email: 'outsider@campus.local' },
    ])
    .returning();
  [member, other, outsider] = [person(m), person(o), person(x)];
  const [cohort] = await db
    .insert(cohorts)
    .values({ name: 'C1', code: 'C1' })
    .returning();
  cohortId = cohort.id;
  await db.insert(cohortMembers).values([
    { userId: member.id, cohortId, role: CohortRole.Mentor },
    { userId: other.id, cohortId, role: CohortRole.Mentor },
  ]);
  const [map] = await db
    .insert(maps)
    .values({ key: 'campus', name: 'Campus' })
    .returning();
  const [library, office] = await db
    .insert(spaces)
    .values([
      {
        mapId: map.id,
        key: 'library',
        name: 'Library',
        kind: SpaceKind.MeetingRoom,
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Normal,
      },
      {
        mapId: map.id,
        key: 'office',
        name: 'Office',
        kind: SpaceKind.MeetingRoom,
        audioMode: AudioMode.Boundary,
        access: SpaceAccess.Designated,
      },
    ])
    .returning();
  spaceId = library.id;
  designatedId = office.id;
  room = spaceRoomName({ cohortId, spaceId });
});

describe('call chat attachments', () => {
  it('ties a file to the call, for anyone who may enter the space to open', async () => {
    await calls.record(event('room_started'), new Date());
    const id = await file();

    const attachment = await send(id);

    expect(attachment).toMatchObject({
      id,
      fileName: 'plan.pdf',
      contentType: 'application/pdf',
      url: expect.stringMatching(/^https:\/\/r2\.test\/call-chat\/.+\?read$/),
    });
    await expect(read(other, id)).resolves.toBeDefined();
    await expect(read(outsider, id)).rejects.toThrow(MediaNotFoundException);
  });

  it('answers 410 once the call ends, and keeps the file a week', async () => {
    await calls.record(event('room_started'), new Date());
    const id = await file();
    await send(id);
    const end = new Date();

    await calls.record(event('room_finished'), end);

    expect(await statusOf(id)).toMatchObject({
      status: MediaStatus.Removed,
      purgeAfter: new Date(end.getTime() + 7 * DAY_MS),
    });
    await expect(read(other, id)).rejects.toThrow(MediaGoneException);
    await expect(read(outsider, id)).rejects.toThrow(MediaNotFoundException);
  });

  it('lets go of the files when a newer run replaces a call whose end was missed', async () => {
    await calls.record(event('room_started'), new Date());
    const id = await file();
    await send(id);

    await calls.record(event('room_started', 'RM_2'), new Date());

    expect((await statusOf(id)).status).toBe(MediaStatus.Removed);
  });

  it('refuses when no call is going on, and leaves the upload to try again', async () => {
    const id = await file();

    await expect(send(id)).rejects.toThrow(NoOpenCallException);
    expect((await statusOf(id)).status).toBe(MediaStatus.Pending);
  });

  it('refuses somebody who may not enter the space, and a space that is not there', async () => {
    await calls.record(event('room_started'), new Date());

    await expect(send(await file(outsider.id), outsider.id)).rejects.toThrow(
      CallChatForbiddenException,
    );
    await expect(send(await file(), member.id, designatedId)).rejects.toThrow(
      CallChatForbiddenException,
    );
    await expect(
      send(await file(), member.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(CallChatNotFoundException);
  });

  it('lets an admin outside the cohort send and open files', async () => {
    const [row] = await db
      .insert(users)
      .values({ email: 'admin@campus.local', systemRole: SystemRole.Admin })
      .returning();
    const admin = person(row);
    await calls.record(event('room_started'), new Date());
    const mine = await file();
    await send(mine);

    const theirs = await send(await file(admin.id), admin.id);

    await expect(read(member, theirs.id)).resolves.toBeDefined();
    await expect(read(admin, mine)).resolves.toBeDefined();
  });

  it('refuses an upload that is not the sender’s', async () => {
    await calls.record(event('room_started'), new Date());
    const theirs = await file(other.id);

    await expect(send(theirs)).rejects.toThrow(UploadNotFoundException);
  });
});
