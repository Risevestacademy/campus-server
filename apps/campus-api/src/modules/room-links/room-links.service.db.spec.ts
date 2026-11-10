import { DEFAULT_SPACE_KEY } from '@campus/session';
import { PGlite } from '@electric-sql/pglite';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

import type { Env } from '../../infra/config/config.module.js';
import * as schema from '../../infra/database/schema/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { AuditAction, AuditSubjectType, auditLog } from '../audit/schema.js';
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
import { roomLinkInstances, roomLinkPasses, roomLinks } from './schema.js';

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
      { actorUserId: mentor.id },
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
      startsAt: null,
      endsAt: null,
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
      { actorUserId: mentor.id },
      later,
    );
    const older = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Standup',
      { actorUserId: mentor.id },
      earlier,
    );
    const listed = await service.list(mentor, cohortId, pod.id);

    expect(newer.code).not.toBe(older.code);
    expect(listed.map((link) => link.title)).toEqual(['Retro', 'Standup']);
  }, 30_000);

  it('lets admins in without a place in the cohort, and only staff manage links', async () => {
    const { cohortId, mentor, guest, admin, pod } = await setting();

    const made = await service.create(admin, cohortId, pod.id, 'Town hall', {
      actorUserId: admin.id,
    });
    await expect(service.open(admin, made.code)).resolves.toMatchObject({
      cohortId,
    });
    await expect(
      service.create(guest, cohortId, pod.id, 'Mine', {
        actorUserId: guest.id,
      }),
    ).rejects.toThrow(RoomLinkForbiddenException);
    await expect(service.list(guest, cohortId, pod.id)).rejects.toThrow(
      RoomLinkForbiddenException,
    );
    await expect(
      service.revoke(guest, made.code, { actorUserId: guest.id }),
    ).rejects.toThrow(RoomLinkForbiddenException);
    await expect(service.list(mentor, cohortId, pod.id)).resolves.toHaveLength(
      1,
    );
  }, 30_000);

  it('is a 404 to anybody without a live place in its cohort', async () => {
    const { cohortId, mentor, guest, outsider, pod } = await setting();
    const made = await service.create(mentor, cohortId, pod.id, 'Class', {
      actorUserId: mentor.id,
    });

    await expect(service.open(outsider, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
    await expect(
      service.revoke(outsider, made.code, { actorUserId: outsider.id }),
    ).rejects.toThrow(RoomLinkNotFoundException);

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
    const kept = await service.create(mentor, cohortId, pod.id, 'Kept', {
      actorUserId: mentor.id,
    });
    const dropped = await service.create(mentor, cohortId, pod.id, 'Dropped', {
      actorUserId: mentor.id,
    });

    await service.revoke(mentor, dropped.code, { actorUserId: mentor.id });
    await service.revoke(mentor, dropped.code, { actorUserId: mentor.id });

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
    const made = await service.create(mentor, cohortId, pod.id, 'Lab', {
      actorUserId: mentor.id,
    });
    const unkinded = await space(unique(), null);

    await db
      .update(spaces)
      .set({ retiredAt: new Date() })
      .where(eq(spaces.id, pod.id));

    await expect(service.open(guest, made.code)).rejects.toThrow(
      RoomLinkNotFoundException,
    );
    await expect(
      service.create(mentor, cohortId, pod.id, 'Again', {
        actorUserId: mentor.id,
      }),
    ).rejects.toThrow(RoomLinkNotFoundException);
    await expect(
      service.create(mentor, cohortId, unkinded.id, 'Nope', {
        actorUserId: mentor.id,
      }),
    ).rejects.toThrow(RoomLinkNotFoundException);
  }, 30_000);

  it('only leads to spaces on the entry map, which world plays', async () => {
    const { cohortId, mentor, guest } = await setting();
    const annexRoom = await space(unique(), SpaceKind.MeetingRoom, otherMapId);

    await expect(
      service.create(mentor, cohortId, annexRoom.id, 'Off the map', {
        actorUserId: mentor.id,
      }),
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
      service.create(mentor, cohortId, corridors.id, 'Hallway chat', {
        actorUserId: mentor.id,
      }),
    ).rejects.toThrow(RoomLinkNotFoundException);
  }, 30_000);

  it('dates a link by the same clock that revokes it', async () => {
    const { cohortId, mentor, pod } = await setting();
    const behind = new Date(Date.now() - 60_000);

    const made = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Sync',
      { actorUserId: mentor.id },
      behind,
    );

    expect(made.createdAt).toEqual(behind);
    await expect(
      service.revoke(
        mentor,
        made.code,
        { actorUserId: mentor.id },
        new Date(behind.getTime() + 1),
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('audits making and revoking a link, and nothing else', async () => {
    const { cohortId, mentor, guest, pod } = await setting();

    const made = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Office hours',
      { actorUserId: mentor.id, correlationId: 'req-1' },
    );
    await service.open(guest, made.code);
    await expect(
      service.create(guest, cohortId, pod.id, 'Mine', {
        actorUserId: guest.id,
      }),
    ).rejects.toThrow(RoomLinkForbiddenException);
    await service.revoke(mentor, made.code, { actorUserId: mentor.id });
    await service.revoke(mentor, made.code, { actorUserId: mentor.id });

    const [link] = await db
      .select({ id: roomLinks.id })
      .from(roomLinks)
      .where(eq(roomLinks.code, made.code));
    const entries = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.actorUserId, [mentor.id, guest.id]))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.action));
    const details = { cohortId, code: made.code, title: 'Office hours' };
    expect(entries).toMatchObject([
      {
        action: AuditAction.RoomLinkCreated,
        actorUserId: mentor.id,
        subjectType: AuditSubjectType.RoomLink,
        subjectId: link.id,
        spaceId: pod.id,
        correlationId: 'req-1',
        details,
      },
      {
        action: AuditAction.RoomLinkRevoked,
        actorUserId: mentor.id,
        subjectId: link.id,
        spaceId: pod.id,
        details,
      },
    ]);
    expect(entries).toHaveLength(2);
  }, 30_000);

  it('resolves many codes at once, to only the links the caller may open', async () => {
    const { cohortId, mentor, guest, outsider, admin, pod } = await setting();
    const audit = { actorUserId: mentor.id };
    const kept = await service.create(mentor, cohortId, pod.id, 'Kept', audit);
    const dropped = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Dropped',
      audit,
    );
    await service.revoke(mentor, dropped.code, audit);
    const retired = await space('retired', SpaceKind.MeetingRoom);
    const gone = await service.create(
      mentor,
      cohortId,
      retired.id,
      'Gone',
      audit,
    );
    await db
      .update(spaces)
      .set({ retiredAt: new Date() })
      .where(eq(spaces.id, retired.id));
    const codes = [kept.code, dropped.code, gone.code, 'nOsUcHc0de', 'bad'];
    const target = {
      code: kept.code,
      cohortId,
      spaceId: pod.id,
      spaceKey: pod.key,
      spaceName: pod.name,
      title: 'Kept',
    };

    expect(await service.resolve(guest, codes)).toEqual([target]);
    expect(await service.resolve(admin, codes)).toEqual([target]);
    expect(await service.resolve(outsider, codes)).toEqual([]);
    expect(await service.resolve(guest, [])).toEqual([]);
  }, 30_000);

  it('resolves nothing for a member whose place has lapsed', async () => {
    const { cohortId, mentor, guest, pod } = await setting();
    const made = await service.create(mentor, cohortId, pod.id, 'Later', {
      actorUserId: mentor.id,
    });
    const afterExpiry = new Date(Date.now() + 2 * 86_400_000);

    expect(await service.resolve(guest, [made.code], afterExpiry)).toEqual([]);
  }, 30_000);

  describe('runs and entering', () => {
    const MINUTE = 60_000;
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
    const run = { startsAt: at(15), endsAt: at(75) };

    const passesFor = (code: string) =>
      db
        .select({ userId: roomLinkPasses.userId })
        .from(roomLinkPasses)
        .innerJoin(roomLinks, eq(roomLinks.id, roomLinkPasses.roomLinkId))
        .where(eq(roomLinks.code, code));

    const synced = async (
      code: string,
      organizerId: string,
      runs: { startsAt: Date; endsAt: Date; cancelledAt?: Date }[],
    ) => {
      const [link] = await db
        .select({ id: roomLinks.id })
        .from(roomLinks)
        .where(eq(roomLinks.code, code));
      await db.insert(roomLinkInstances).values(
        runs.map((r, n) => ({
          roomLinkId: link.id,
          organizerId,
          googleEventId: `${code}_${n}`,
          ...r,
        })),
      );
    };

    it('shows the run going on now, else the next, and none when none is coming', async () => {
      const { cohortId, mentor, guest, pod } = await setting();
      const made = await service.create(mentor, cohortId, pod.id, 'Class', {
        actorUserId: mentor.id,
      });
      expect(made).toMatchObject({ startsAt: null, endsAt: null });

      await synced(made.code, mentor.id, [
        { startsAt: at(-120), endsAt: at(-60) },
        { startsAt: at(-5), endsAt: at(1), cancelledAt: at(-30) },
        run,
        { startsAt: at(7 * 24 * 60), endsAt: at(7 * 24 * 60 + 60) },
      ]);

      expect(await service.open(guest, made.code)).toMatchObject(run);
      expect((await service.list(mentor, cohortId, pod.id))[0]).toMatchObject(
        run,
      );
      expect(await service.open(guest, made.code, at(76))).toMatchObject({
        startsAt: at(7 * 24 * 60),
      });
    }, 30_000);

    it('gives a pass from ten minutes before a run starts until it ends, once', async () => {
      const { cohortId, mentor, guest, pod } = await setting();
      const made = await service.create(mentor, cohortId, pod.id, 'Class', {
        actorUserId: mentor.id,
      });
      await synced(made.code, mentor.id, [run]);

      await expect(
        service.enter(guest, made.code, at(4)),
      ).resolves.toMatchObject({ admitted: false });
      expect(await passesFor(made.code)).toEqual([]);

      await expect(
        service.enter(guest, made.code, at(5)),
      ).resolves.toMatchObject({ admitted: true, ...run });
      await service.enter(guest, made.code, at(30));
      expect(await passesFor(made.code)).toEqual([{ userId: guest.id }]);

      await expect(
        service.enter(guest, made.code, at(75)),
      ).resolves.toMatchObject({ admitted: false });
    }, 30_000);

    it('admits nobody through a cancelled run', async () => {
      const { cohortId, mentor, guest, pod } = await setting();
      const made = await service.create(mentor, cohortId, pod.id, 'Off', {
        actorUserId: mentor.id,
      });
      await synced(made.code, mentor.id, [
        { startsAt: at(-5), endsAt: at(55), cancelledAt: at(-60) },
      ]);

      await expect(service.enter(guest, made.code, now)).resolves.toMatchObject(
        {
          admitted: false,
          startsAt: null,
        },
      );
      expect(await passesFor(made.code)).toEqual([]);
    }, 30_000);

    it('admits admins without a pass, and nobody through a link no event carries', async () => {
      const { cohortId, mentor, guest, admin, pod } = await setting();
      const made = await service.create(mentor, cohortId, pod.id, 'Open', {
        actorUserId: mentor.id,
      });

      await expect(service.enter(admin, made.code, now)).resolves.toMatchObject(
        {
          admitted: true,
        },
      );
      await expect(service.enter(guest, made.code, now)).resolves.toMatchObject(
        {
          admitted: false,
          startsAt: null,
        },
      );
      expect(await passesFor(made.code)).toEqual([]);
    }, 30_000);

    it('is a 404 to enter for anybody without a live place in its cohort', async () => {
      const { cohortId, mentor, outsider, pod } = await setting();
      const made = await service.create(mentor, cohortId, pod.id, 'Class', {
        actorUserId: mentor.id,
      });

      await expect(service.enter(outsider, made.code, now)).rejects.toThrow(
        RoomLinkNotFoundException,
      );
    }, 30_000);
  });
});
