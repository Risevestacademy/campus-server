import { roomLinkOpen } from '@campus/space-access';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { appUrl } from '../../shared/http/app-url.js';
import { writeAuditEntry, type AuditContext } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps, spaces } from '../maps/schema.js';
import { tellWorld } from '../maps/tell-world.js';
import { UserStatus, hasAdminPowers, users } from '../users/schema.js';
import type {
  RoomLinkDto,
  RoomLinkEntryDto,
  RoomLinkTargetDto,
} from './dto/room-link.dto.js';
import {
  ROOM_LINK_CODE,
  ROOM_LINK_PATH,
  generateRoomLinkCode,
} from './room-link-code.js';
import {
  RoomLinkForbiddenException,
  RoomLinkNotFoundException,
} from './room-links.exceptions.js';
import {
  RoomLinkAudience,
  roomLinkInstances,
  roomLinkPasses,
  roomLinks,
} from './schema.js';

type Standing = 'admin' | 'staff' | 'member';

export interface LinkAudience {
  audience?: RoomLinkAudience;
  cohortTrackId?: string;
  mentorshipGroupId?: string;
}

/** One run of a link's event. */
interface Run {
  startsAt: Date;
  endsAt: Date;
}

const STAFF_ROLES: readonly CohortRole[] = [
  CohortRole.Professor,
  CohortRole.Mentor,
];

const CODE_ATTEMPTS = 3;

const liveSpace: SQL = and(
  isNull(spaces.retiredAt),
  isNotNull(spaces.kind),
  isNull(maps.retiredAt),
  eq(maps.isEntry, true),
  eq(spaces.isMapDefault, false),
) as SQL;

const linkColumns = {
  id: roomLinks.id,
  code: roomLinks.code,
  title: roomLinks.title,
  cohortId: roomLinks.cohortId,
  spaceId: roomLinks.spaceId,
  spaceKey: spaces.key,
  spaceName: spaces.name,
  audience: roomLinks.audience,
  cohortTrackId: roomLinks.cohortTrackId,
  mentorshipGroupId: roomLinks.mentorshipGroupId,
  createdAt: roomLinks.createdAt,
};

type LinkRow = Omit<RoomLinkDto, 'url' | 'startsAt' | 'endsAt'> & {
  id: string;
};

const targetColumns = {
  code: roomLinks.code,
  cohortId: roomLinks.cohortId,
  spaceId: roomLinks.spaceId,
  spaceKey: spaces.key,
  spaceName: spaces.name,
  title: roomLinks.title,
};

/**
 * Links to a space in one cohort's campus, one per event. Admins and the
 * cohort's professors and mentors make, list and revoke them; anybody with a
 * live place in the cohort, and any admin, opens one. When the event runs
 * comes from its runs synced from the organiser's calendar.
 */
@Injectable()
export class RoomLinksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  async create(
    user: AuthenticatedUser,
    cohortId: string,
    spaceId: string,
    title: string,
    audit: AuditContext,
    now: Date = new Date(),
    target: LinkAudience = {},
  ): Promise<RoomLinkDto> {
    const audience = audienceColumns(target);
    await requireStaff(this.db, user, cohortId, now);
    await requireLiveSpace(this.db, spaceId);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const [link] = await tx
            .insert(roomLinks)
            .values({
              code: generateRoomLinkCode(),
              cohortId,
              spaceId,
              title,
              createdBy: user.id,
              createdAt: now,
              ...audience,
            })
            .returning({ id: roomLinks.id, code: roomLinks.code });
          await writeAuditEntry(tx, {
            ...audit,
            spaceId,
            action: AuditAction.RoomLinkCreated,
            subject: { type: AuditSubjectType.RoomLink, id: link.id },
            details: { cohortId, code: link.code, title, ...audience },
          });
          return this.toDto(await this.find(link.code, tx), null);
        });
      } catch (err) {
        if (
          attempt < CODE_ATTEMPTS &&
          isUniqueViolation(err, 'room_links_code_unique')
        ) {
          continue;
        }
        if (
          isForeignKeyViolation(err, 'room_links_cohort_track_fk') ||
          isForeignKeyViolation(err, 'room_links_mentorship_group_fk')
        ) {
          throw new RoomLinkNotFoundException(
            'No such track or pod in this cohort',
            { cohortId, ...audience },
          );
        }
        throw err;
      }
    }
  }

  /** The space's live links in this cohort, newest first. */
  async list(
    user: AuthenticatedUser,
    cohortId: string,
    spaceId: string,
    now: Date = new Date(),
  ): Promise<RoomLinkDto[]> {
    await requireStaff(this.db, user, cohortId, now);
    await requireLiveSpace(this.db, spaceId);
    const rows = await this.db
      .select(linkColumns)
      .from(roomLinks)
      .innerJoin(spaces, eq(spaces.id, roomLinks.spaceId))
      .innerJoin(maps, eq(maps.id, spaces.mapId))
      .where(
        and(
          eq(roomLinks.cohortId, cohortId),
          eq(roomLinks.spaceId, spaceId),
          isNull(roomLinks.revokedAt),
          liveSpace,
        ),
      )
      .orderBy(desc(roomLinks.createdAt), desc(roomLinks.id));
    const runs = await nextRuns(
      this.db,
      rows.map((row) => row.id),
      now,
    );
    return rows.map((row) => this.toDto(row, runs.get(row.id) ?? null));
  }

  /**
   * Where a link leads. A revoked link, one to a space no longer on the entry
   * map, and one to a cohort the caller holds no place in are all a 404, so a
   * code says nothing to somebody it is not for.
   */
  async open(
    user: AuthenticatedUser,
    code: string,
    now: Date = new Date(),
  ): Promise<RoomLinkDto> {
    const { link } = await this.forEntry(user, code, now);
    const runs = await nextRuns(this.db, [link.id], now);
    return this.toDto(link, runs.get(link.id) ?? null);
  }

  /**
   * Opens the link to walk into its space. Somebody entering while a run is
   * open (from ten minutes before it starts until it ends) gets a pass, which
   * world honours whenever a run of the link is open. Admins enter anywhere.
   */
  async enter(
    user: AuthenticatedUser,
    code: string,
    now: Date = new Date(),
  ): Promise<RoomLinkEntryDto> {
    const { link, standing: held } = await this.forEntry(user, code, now);
    const run = (await nextRuns(this.db, [link.id], now)).get(link.id) ?? null;
    const open = run !== null && roomLinkOpen(run, now);
    if (open && held !== 'admin') {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(roomLinkPasses)
          .values({ roomLinkId: link.id, userId: user.id, createdAt: now })
          .onConflictDoNothing();
        await tellWorld(tx);
      });
    }
    return {
      ...this.toDto(link, run),
      admitted: open || held === 'admin',
    };
  }

  private async forEntry(
    user: AuthenticatedUser,
    code: string,
    now: Date,
  ): Promise<{ link: LinkRow; standing: Standing }> {
    const link = await this.find(code);
    try {
      return {
        link,
        standing: await standing(this.db, user, link.cohortId, now),
      };
    } catch (err) {
      if (err instanceof RoomLinkForbiddenException) {
        throw notFound(code);
      }
      throw err;
    }
  }

  /**
   * Of these codes, the links the caller may open, by the same rules as
   * `open`: not revoked, the space live on the entry map and not the
   * corridors, and the caller a live member of the link's cohort or an admin.
   * Codes that fail any of that are left out rather than refused, so one
   * lookup serves a whole list of events. In no particular order.
   */
  async resolve(
    user: AuthenticatedUser,
    codes: readonly string[],
    now: Date = new Date(),
  ): Promise<RoomLinkTargetDto[]> {
    const wanted = [...new Set(codes)].filter((c) => ROOM_LINK_CODE.test(c));
    if (wanted.length === 0) {
      return [];
    }
    const [account] = await this.db
      .select({ systemRole: users.systemRole, status: users.status })
      .from(users)
      .where(eq(users.id, user.id));
    if (!account || account.status === UserStatus.Suspended) {
      return [];
    }
    const member = hasAdminPowers(account.systemRole)
      ? undefined
      : exists(
          this.db
            .select({ one: sql`1` })
            .from(cohortMembers)
            .where(
              and(
                eq(cohortMembers.cohortId, roomLinks.cohortId),
                eq(cohortMembers.userId, user.id),
                isLiveMembership(now),
              ),
            ),
        );
    return this.db
      .select(targetColumns)
      .from(roomLinks)
      .innerJoin(spaces, eq(spaces.id, roomLinks.spaceId))
      .innerJoin(maps, eq(maps.id, spaces.mapId))
      .where(
        and(
          inArray(roomLinks.code, wanted),
          isNull(roomLinks.revokedAt),
          liveSpace,
          member,
        ),
      );
  }

  /** Revoking a link already revoked changes nothing, and writes no entry. */
  async revoke(
    user: AuthenticatedUser,
    code: string,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<void> {
    const [link] = await this.db
      .select({ id: roomLinks.id, cohortId: roomLinks.cohortId })
      .from(roomLinks)
      .where(eq(roomLinks.code, code));
    if (!link) {
      throw notFound(code);
    }
    let held: Standing;
    try {
      held = await standing(this.db, user, link.cohortId, now);
    } catch (err) {
      if (err instanceof RoomLinkForbiddenException) {
        throw notFound(code);
      }
      throw err;
    }
    if (held === 'member') {
      throw new RoomLinkForbiddenException(
        'Only staff and admins may revoke a room link',
        { code },
      );
    }
    await this.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(roomLinks)
        .set({ revokedAt: now })
        .where(and(eq(roomLinks.id, link.id), isNull(roomLinks.revokedAt)))
        .returning({ spaceId: roomLinks.spaceId, title: roomLinks.title });
      if (!revoked) {
        return;
      }
      await writeAuditEntry(tx, {
        ...audit,
        spaceId: revoked.spaceId,
        action: AuditAction.RoomLinkRevoked,
        subject: { type: AuditSubjectType.RoomLink, id: link.id },
        details: { cohortId: link.cohortId, code, title: revoked.title },
      });
      await tellWorld(tx);
    });
  }

  private async find(code: string, db: DbExecutor = this.db): Promise<LinkRow> {
    const [link] = await db
      .select(linkColumns)
      .from(roomLinks)
      .innerJoin(spaces, eq(spaces.id, roomLinks.spaceId))
      .innerJoin(maps, eq(maps.id, spaces.mapId))
      .where(
        and(eq(roomLinks.code, code), isNull(roomLinks.revokedAt), liveSpace),
      );
    if (!link) {
      throw notFound(code);
    }
    return link;
  }

  private toDto({ id: _id, ...row }: LinkRow, run: Run | null): RoomLinkDto {
    return {
      ...row,
      startsAt: run?.startsAt ?? null,
      endsAt: run?.endsAt ?? null,
      url: appUrl(this.config, `${ROOM_LINK_PATH}${row.code}`),
    };
  }
}

function audienceColumns(target: LinkAudience) {
  const audience = target.audience ?? RoomLinkAudience.Cohort;
  const track = audience === RoomLinkAudience.CohortTrack;
  const group = audience === RoomLinkAudience.MentorshipGroup;
  if (track !== Boolean(target.cohortTrackId)) {
    throw new InvalidArgumentException(
      'cohortTrackId is given with, and only with, the cohort-track audience',
      { audience },
    );
  }
  if (group !== Boolean(target.mentorshipGroupId)) {
    throw new InvalidArgumentException(
      'mentorshipGroupId is given with, and only with, the mentorship-group audience',
      { audience },
    );
  }
  return {
    audience,
    cohortTrackId: target.cohortTrackId ?? null,
    mentorshipGroupId: target.mentorshipGroupId ?? null,
  };
}

/** Each link's run going on now, else its next, leaving out cancelled ones. */
async function nextRuns(
  db: DbExecutor,
  linkIds: string[],
  now: Date,
): Promise<Map<string, Run>> {
  if (linkIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([roomLinkInstances.roomLinkId], {
      roomLinkId: roomLinkInstances.roomLinkId,
      startsAt: roomLinkInstances.startsAt,
      endsAt: roomLinkInstances.endsAt,
    })
    .from(roomLinkInstances)
    .where(
      and(
        inArray(roomLinkInstances.roomLinkId, linkIds),
        isNull(roomLinkInstances.cancelledAt),
        gt(roomLinkInstances.endsAt, now),
      ),
    )
    .orderBy(roomLinkInstances.roomLinkId, asc(roomLinkInstances.startsAt));
  return new Map(rows.map(({ roomLinkId, ...run }) => [roomLinkId, run]));
}

function notFound(code: string): RoomLinkNotFoundException {
  return new RoomLinkNotFoundException('No such room link', { code });
}

/**
 * What the caller is to the cohort, read from the account and the roster
 * rather than the session: an admin once the cohort is known to exist,
 * otherwise a live member as staff or not.
 */
async function standing(
  db: DbExecutor,
  user: AuthenticatedUser,
  cohortId: string,
  now: Date,
): Promise<Standing> {
  const [account] = await db
    .select({ systemRole: users.systemRole, status: users.status })
    .from(users)
    .where(eq(users.id, user.id));
  if (!account || account.status === UserStatus.Suspended) {
    throw new RoomLinkForbiddenException(
      'This account may not use room links',
      { cohortId },
    );
  }

  if (hasAdminPowers(account.systemRole)) {
    const [cohort] = await db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId))
      .limit(1);
    if (!cohort) {
      throw new CohortNotFoundException(`No cohort with id ${cohortId}`, {
        cohortId,
      });
    }
    return 'admin';
  }

  const [member] = await db
    .select({ role: cohortMembers.role })
    .from(cohortMembers)
    .where(
      and(
        eq(cohortMembers.cohortId, cohortId),
        eq(cohortMembers.userId, user.id),
        isLiveMembership(now),
      ),
    );
  if (!member) {
    throw new RoomLinkForbiddenException(
      "Only the cohort's live members and admins may use its room links",
      { cohortId },
    );
  }
  return STAFF_ROLES.includes(member.role) ? 'staff' : 'member';
}

async function requireStaff(
  db: DbExecutor,
  user: AuthenticatedUser,
  cohortId: string,
  now: Date,
): Promise<void> {
  if ((await standing(db, user, cohortId, now)) === 'member') {
    throw new RoomLinkForbiddenException(
      "Only the cohort's professors and mentors, and admins, manage room links",
      { cohortId },
    );
  }
}

async function requireLiveSpace(
  db: DbExecutor,
  spaceId: string,
): Promise<void> {
  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .innerJoin(maps, eq(maps.id, spaces.mapId))
    .where(and(eq(spaces.id, spaceId), liveSpace));
  if (!space) {
    throw new RoomLinkNotFoundException(
      'No space with that id is set up on the entry map',
      { spaceId },
    );
  }
}
