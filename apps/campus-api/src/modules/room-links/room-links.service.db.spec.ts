import { DEFAULT_SPACE_KEY } from '@campus/session';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Env } from '../../infra/config/config.module.js';
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
import { SystemRole, users } from '../users/schema.js';
import { ROOM_LINK_CODE } from './room-link-code.js';
import {
  RoomLinkForbiddenException,
  RoomLinkNotFoundException,
} from './room-links.exceptions.js';
import { RoomLinksService } from './room-links.service.js';
import { roomLinks } from './schema.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

const db = drizzle(new PGlite(), { schema });
const service = new RoomLinksService(
  db as never,
  {
    APP_PUBLIC_URL: 'https://campus.test/',
  } as Env,
);

let counter = 0;
const unique = () => `${++counter}`;

describe('RoomLinksService', () => {
  let mapId: string;
  let otherMapId: string;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const [entry, other] = await db
      .insert(maps)
      .values([
        { key: 'campus', name: 'Campus', isEntry: true },
        { key: 'annex', name: 'Annex' },
      ])
      .returning();
    mapId = entry.id;
    otherMapId = other.id;
  });

  const person = async (
    tag: string,
    name: string,
    systemRole = SystemRole.User,
  ): Promise<AuthenticatedUser> => {
    const [row] = await db
      .insert(users)
      .values({ email: `${name}-${tag}@campus.local`, systemRole })
      .returning();
    return { id: row.id, email: row.email, systemRole };
  };

  const space = async (tag: string, kind: SpaceKind | null, on = mapId) => {
    const [row] = await db
      .insert(spaces)
      .values({
        mapId: on,
        key: `pod-${unique()}`,
        name: `Pod ${tag}`,
        kind,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
      })
      .returning();
    return row;
  };

  /** A cohort with a mentor and a guest, an admin and an outsider, and a pod. */
  const setting = async () => {
    const tag = unique();
    const [cohort] = await db
      .insert(cohorts)
      .values({ name: 'Links', code: `L${tag}`.toUpperCase().slice(0, 32) })
      .returning();
    const mentor = await person(tag, 'mentor');
    const guest = await person(tag, 'guest');
    const outsider = await person(tag, 'outsider');
    const admin = await person(tag, 'admin', SystemRole.Admin);
    await db.insert(cohortMembers).values([
      { cohortId: cohort.id, userId: mentor.id, role: CohortRole.Mentor },
      {
        cohortId: cohort.id,
        userId: guest.id,
        role: CohortRole.Guest,
        accessExpiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const pod = await space(tag, SpaceKind.MeetingRoom);
    return { cohortId: cohort.id, mentor, guest, outsider, admin, pod };
  };

  it('makes a link a member opens to the cohort, space and event', async () => {
    const { cohortId, mentor, guest, pod } = await setting();

    const made = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Design review',
    );
    const opened = await service.open(guest, made.code);

    expect(made.code).toMatch(ROOM_LINK_CODE);
    expect(made.url).toBe(`https://campus.test/join/${made.code}`);
    expect(opened).toEqual({
      code: made.code,
      url: made.url,
      title: 'Design review',
      cohortId,
      spaceId: pod.id,
      spaceKey: pod.key,
      spaceName: pod.name,
      createdAt: made.createdAt,
    });
  }, 30_000);

  it('keeps several live links to one space, one per event, newest first', async () => {
    const { cohortId, mentor, pod } = await setting();
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date(Date.now() - 30_000);

    const newer = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Retro',
      later,
    );
    const older = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Standup',
      earlier,
    );
    const listed = await service.list(mentor, cohortId, pod.id);

    expect(newer.code).not.toBe(older.code);
    expect(listed.map((link) => link.title)).toEqual(['Retro', 'Standup']);
  }, 30_000);

  it('lets admins in without a place in the cohort, and only staff manage links', async () => {
    const { cohortId, mentor, guest, admin, pod } = await setting();

    const made = await service.create(admin, cohortId, pod.id, 'Town hall');
    await expect(service.open(admin, made.code)).resolves.toMatchObject({
      cohortId,
    });
    await expect(
      service.create(guest, cohortId, pod.id, 'Mine'),
    ).rejects.toThrow(RoomLinkForbiddenException);
    await expect(service.list(guest, cohortId, pod.id)).rejects.toThrow(
      RoomLinkForbiddenException,
    );
    await expect(service.revoke(guest, made.code)).rejects.toThrow(
      RoomLinkForbiddenException,
    );
    await expect(service.list(mentor, cohortId, pod.id)).resolves.toHaveLength(
      1,
    );
  }, 30_000);

  it('is a 404 to anybody without a live place in its cohort', async () => {
    const { cohortId, mentor, guest, outsider, pod } = await setting();
    const made = await service.create(mentor, cohortId, pod.id, 'Class');

    await expect(service.open(outsider, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
    await expect(service.revoke(outsider, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );

    await db
      .update(cohortMembers)
      .set({ leftAt: new Date() })
      .where(eq(cohortMembers.userId, guest.id));
    await expect(service.open(guest, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
  }, 30_000);

  it('stops opening once revoked, and revoking again changes nothing', async () => {
    const { cohortId, mentor, guest, pod } = await setting();
    const kept = await service.create(mentor, cohortId, pod.id, 'Kept');
    const dropped = await service.create(mentor, cohortId, pod.id, 'Dropped');

    await service.revoke(mentor, dropped.code);
    await service.revoke(mentor, dropped.code);

    await expect(service.open(guest, dropped.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
    await expect(service.open(guest, kept.code)).resolves.toMatchObject({
      title: 'Kept',
    });
    const listed = await service.list(mentor, cohortId, pod.id);
    expect(listed.map((link) => link.code)).toEqual([kept.code]);
  }, 30_000);

  it('leads nowhere once its space is retired, and is not made for a space not set up', async () => {
    const { cohortId, mentor, guest, pod } = await setting();
    const made = await service.create(mentor, cohortId, pod.id, 'Lab');
    const unkinded = await space(unique(), null);

    await db
      .update(spaces)
      .set({ retiredAt: new Date() })
      .where(eq(spaces.id, pod.id));

    await expect(service.open(guest, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
    await expect(
      service.create(mentor, cohortId, pod.id, 'Again'),
    ).rejects.toThrow(RoomLinkNotFoundException);
    await expect(
      service.create(mentor, cohortId, unkinded.id, 'Nope'),
    ).rejects.toThrow(RoomLinkNotFoundException);
  }, 30_000);

  it('only leads to spaces on the entry map, which world plays', async () => {
    const { cohortId, mentor, guest } = await setting();
    const annexRoom = await space(unique(), SpaceKind.MeetingRoom, otherMapId);

    await expect(
      service.create(mentor, cohortId, annexRoom.id, 'Off the map'),
    ).rejects.toThrow(RoomLinkNotFoundException);

    await db.insert(roomLinks).values({
      code: 'AnnexLink1',
      cohortId,
      spaceId: annexRoom.id,
      title: 'Made before the entry map moved',
      createdBy: mentor.id,
    });
    await expect(service.open(guest, 'AnnexLink1')).rejects.toThrow(
      RoomLinkNotFoundException,
    );
  }, 30_000);

  it('is not made for the corridors, where no meeting happens', async () => {
    const { cohortId, mentor } = await setting();
    const [corridors] = await db
      .insert(spaces)
      .values({
        mapId,
        key: DEFAULT_SPACE_KEY,
        name: 'Corridors',
        kind: SpaceKind.Open,
        isMapDefault: true,
        audioMode: AudioMode.Proximity,
        access: SpaceAccess.Normal,
      })
      .returning();

    await expect(
      service.create(mentor, cohortId, corridors.id, 'Hallway chat'),
    ).rejects.toThrow(RoomLinkNotFoundException);
  }, 30_000);

  it('dates a link by the same clock that revokes it', async () => {
    const { cohortId, mentor, pod } = await setting();
    const behind = new Date(Date.now() - 60_000);

    const made = await service.create(mentor, cohortId, pod.id, 'Sync', behind);

    expect(made.createdAt).toEqual(behind);
    await expect(
      service.revoke(mentor, made.code, new Date(behind.getTime() + 1)),
    ).resolves.toBeUndefined();
  }, 30_000);
});
