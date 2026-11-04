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
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { SystemRole, users } from '../users/schema.js';
import { ROOM_LINK_CODE } from './room-link-code.js';
import {
  RoomLinkForbiddenException,
  RoomLinkNotFoundException,
} from './room-links.exceptions.js';
import { RoomLinksService } from './room-links.service.js';
import { roomLinkPasses, roomLinks } from './schema.js';

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
      null,
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
      null,
      { actorUserId: mentor.id },
      later,
    );
    const older = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Standup',
      null,
      { actorUserId: mentor.id },
      earlier,
    );
    const listed = await service.list(mentor, cohortId, pod.id);

    expect(newer.code).not.toBe(older.code);
    expect(listed.map((link) => link.title)).toEqual(['Retro', 'Standup']);
  }, 30_000);

  it('lets admins in without a place in the cohort, and only staff manage links', async () => {
    const { cohortId, mentor, guest, admin, pod } = await setting();

    const made = await service.create(
      admin,
      cohortId,
      pod.id,
      'Town hall',
      null,
      {
        actorUserId: admin.id,
      },
    );
    await expect(service.open(admin, made.code)).resolves.toMatchObject({
      cohortId,
    });
    await expect(
      service.create(guest, cohortId, pod.id, 'Mine', null, {
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
    const made = await service.create(mentor, cohortId, pod.id, 'Class', null, {
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
    const kept = await service.create(mentor, cohortId, pod.id, 'Kept', null, {
      actorUserId: mentor.id,
    });
    const dropped = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Dropped',
      null,
      {
        actorUserId: mentor.id,
      },
    );

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
    const made = await service.create(mentor, cohortId, pod.id, 'Lab', null, {
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
      service.create(mentor, cohortId, pod.id, 'Again', null, {
        actorUserId: mentor.id,
      }),
    ).rejects.toThrow(RoomLinkNotFoundException);
    await expect(
      service.create(mentor, cohortId, unkinded.id, 'Nope', null, {
        actorUserId: mentor.id,
      }),
    ).rejects.toThrow(RoomLinkNotFoundException);
  }, 30_000);

  it('only leads to spaces on the entry map, which world plays', async () => {
    const { cohortId, mentor, guest } = await setting();
    const annexRoom = await space(unique(), SpaceKind.MeetingRoom, otherMapId);

    await expect(
      service.create(mentor, cohortId, annexRoom.id, 'Off the map', null, {
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
      service.create(mentor, cohortId, corridors.id, 'Hallway chat', null, {
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
      null,
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
      null,
      { actorUserId: mentor.id, correlationId: 'req-1' },
    );
    await service.open(guest, made.code);
    await expect(
      service.create(guest, cohortId, pod.id, 'Mine', null, {
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
    const kept = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Kept',
      null,
      audit,
    );
    const dropped = await service.create(
      mentor,
      cohortId,
      pod.id,
      'Dropped',
      null,
      audit,
    );
    await service.revoke(mentor, dropped.code, audit);
    const retired = await space('retired', SpaceKind.MeetingRoom);
    const gone = await service.create(
      mentor,
      cohortId,
      retired.id,
      'Gone',
      null,
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
    const made = await service.create(mentor, cohortId, pod.id, 'Later', null, {
      actorUserId: mentor.id,
    });
    const afterExpiry = new Date(Date.now() + 2 * 86_400_000);

    expect(await service.resolve(guest, [made.code], afterExpiry)).toEqual([]);
  }, 30_000);

  describe('windows and entering', () => {
    const MINUTE = 60_000;
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
    const window = { startsAt: at(15), endsAt: at(75) };

    const passesFor = (code: string) =>
      db
        .select({ userId: roomLinkPasses.userId })
        .from(roomLinkPasses)
        .innerJoin(roomLinks, eq(roomLinks.id, roomLinkPasses.roomLinkId))
        .where(eq(roomLinks.code, code));

    const enter = async (
      user: AuthenticatedUser,
      code: string,
      found: { startsAt: Date; endsAt: Date } | null,
      when: Date,
    ) =>
      service.enter(
        user,
        await service.forEntry(user, code, when),
        found,
        when,
      );

    it('keeps the window a link is made with, and refuses one that ends first', async () => {
      const { cohortId, mentor, guest, pod } = await setting();

      const made = await service.create(
        mentor,
        cohortId,
        pod.id,
        'Class',
        window,
        {
          actorUserId: mentor.id,
        },
      );

      expect(made).toMatchObject(window);
      expect(await service.open(guest, made.code)).toMatchObject(window);
      await expect(
        service.create(
          mentor,
          cohortId,
          pod.id,
          'Backwards',
          { startsAt: window.endsAt, endsAt: window.startsAt },
          { actorUserId: mentor.id },
        ),
      ).rejects.toThrow(InvalidArgumentException);
      await expect(
        db.insert(roomLinks).values({
          code: 'hAlFwInd0w',
          cohortId,
          spaceId: pod.id,
          title: 'Half',
          createdBy: mentor.id,
          startsAt: window.startsAt,
        }),
      ).rejects.toThrow();
    }, 30_000);

    it('gives a pass from ten minutes before the start until the end, once', async () => {
      const { cohortId, mentor, guest, pod } = await setting();
      const made = await service.create(
        mentor,
        cohortId,
        pod.id,
        'Class',
        window,
        {
          actorUserId: mentor.id,
        },
      );

      await expect(enter(guest, made.code, null, at(4))).resolves.toMatchObject(
        {
          admitted: false,
        },
      );
      expect(await passesFor(made.code)).toEqual([]);

      await expect(enter(guest, made.code, null, at(5))).resolves.toMatchObject(
        {
          admitted: true,
          ...window,
        },
      );
      await enter(guest, made.code, null, at(30));
      expect(await passesFor(made.code)).toEqual([{ userId: guest.id }]);

      await expect(
        enter(guest, made.code, null, at(75)),
      ).resolves.toMatchObject({
        admitted: false,
      });
    }, 30_000);

    it('moves the window to the event the maker’s calendar has running now', async () => {
      const { cohortId, mentor, guest, pod } = await setting();
      const made = await service.create(
        mentor,
        cohortId,
        pod.id,
        'Moved',
        window,
        {
          actorUserId: mentor.id,
        },
      );
      const moved = { startsAt: at(-120), endsAt: at(60) };

      await expect(enter(guest, made.code, moved, now)).resolves.toMatchObject({
        admitted: true,
        ...moved,
      });
      expect(await service.open(guest, made.code)).toMatchObject(moved);
      expect(await passesFor(made.code)).toEqual([{ userId: guest.id }]);
    }, 30_000);

    it('admits admins without a pass, and nobody through a link with no window', async () => {
      const { cohortId, mentor, guest, admin, pod } = await setting();
      const made = await service.create(
        mentor,
        cohortId,
        pod.id,
        'Open',
        null,
        {
          actorUserId: mentor.id,
        },
      );

      await expect(enter(admin, made.code, null, now)).resolves.toMatchObject({
        admitted: true,
      });
      await expect(enter(guest, made.code, null, now)).resolves.toMatchObject({
        admitted: false,
        startsAt: null,
      });
      expect(await passesFor(made.code)).toEqual([]);
    }, 30_000);

    it('lets staff set and clear a window, and writes down each change', async () => {
      const { cohortId, mentor, guest, outsider, pod } = await setting();
      const made = await service.create(
        mentor,
        cohortId,
        pod.id,
        'Moving',
        null,
        {
          actorUserId: mentor.id,
        },
      );

      await expect(
        service.setWindow(mentor, made.code, window, {
          actorUserId: mentor.id,
        }),
      ).resolves.toMatchObject(window);
      await expect(
        service.setWindow(mentor, made.code, null, { actorUserId: mentor.id }),
      ).resolves.toMatchObject({ startsAt: null, endsAt: null });
      await expect(
        service.setWindow(guest, made.code, window, { actorUserId: guest.id }),
      ).rejects.toThrow(RoomLinkForbiddenException);
      await expect(
        service.setWindow(outsider, made.code, window, {
          actorUserId: outsider.id,
        }),
      ).rejects.toThrow(RoomLinkNotFoundException);

      const changes = await db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.RoomLinkWindowChanged))
        .orderBy(asc(auditLog.createdAt));
      const iso = {
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
      };
      const none = { startsAt: null, endsAt: null };
      expect(changes.map((c) => c.details)).toEqual(
        expect.arrayContaining([
          { cohortId, code: made.code, before: none, after: iso },
          { cohortId, code: made.code, before: iso, after: none },
        ]),
      );
    }, 30_000);
  });
});
