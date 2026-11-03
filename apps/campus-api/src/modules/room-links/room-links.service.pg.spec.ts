import { eq } from 'drizzle-orm';

import type { Env } from '../../infra/config/config.module.js';
import {
  REAL_POSTGRES_URL,
  connectRealPostgres,
  unique,
} from '../../infra/database/testing/real-postgres.js';
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

describe.skipIf(!REAL_POSTGRES_URL)('RoomLinksService on real Postgres', () => {
  let pg: ReturnType<typeof connectRealPostgres>;
  let service: RoomLinksService;
  let mapId: string;

  beforeAll(async () => {
    pg = connectRealPostgres();
    service = new RoomLinksService(
      pg.db as never,
      {
        APP_PUBLIC_URL: 'https://campus.test/',
      } as Env,
    );
    const [map] = await pg.db
      .insert(maps)
      .values({ key: `room-links-${unique()}`, name: 'Room links' })
      .returning();
    mapId = map.id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const person = async (
    tag: string,
    name: string,
    systemRole = SystemRole.User,
  ): Promise<AuthenticatedUser> => {
    const [row] = await pg.db
      .insert(users)
      .values({ email: `${name}-${tag}@campus.local`, systemRole })
      .returning();
    return { id: row.id, email: row.email, systemRole };
  };

  const space = async (tag: string, kind: SpaceKind | null) => {
    const [row] = await pg.db
      .insert(spaces)
      .values({
        mapId,
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
    const [cohort] = await pg.db
      .insert(cohorts)
      .values({ name: 'Links', code: `L${tag}`.toUpperCase().slice(0, 32) })
      .returning();
    const mentor = await person(tag, 'mentor');
    const guest = await person(tag, 'guest');
    const outsider = await person(tag, 'outsider');
    const admin = await person(tag, 'admin', SystemRole.Admin);
    await pg.db.insert(cohortMembers).values([
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

  it('keeps several live links to one space, one per event', async () => {
    const { cohortId, mentor, pod } = await setting();

    const first = await service.create(mentor, cohortId, pod.id, 'Standup');
    const second = await service.create(mentor, cohortId, pod.id, 'Retro');
    const listed = await service.list(mentor, cohortId, pod.id);

    expect(first.code).not.toBe(second.code);
    expect(listed.map((link) => link.title).sort()).toEqual([
      'Retro',
      'Standup',
    ]);
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

    await pg.db
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

    await pg.db
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
});
