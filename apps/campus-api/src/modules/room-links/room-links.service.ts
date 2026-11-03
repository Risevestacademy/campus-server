import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';

import { CONFIG, type Env } from '../../infra/config/config.module.js';
import {
  DRIZZLE,
  type Db,
  type DbExecutor,
} from '../../infra/database/database.constants.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { appUrl } from '../../shared/http/app-url.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { CohortNotFoundException } from '../cohorts/cohorts.exceptions.js';
import { CohortRole, cohortMembers, cohorts } from '../cohorts/schema.js';
import { maps, spaces } from '../maps/schema.js';
import { UserStatus, hasAdminPowers, users } from '../users/schema.js';
import type { RoomLinkDto } from './dto/room-link.dto.js';
import { ROOM_LINK_PATH, generateRoomLinkCode } from './room-link-code.js';
import {
  RoomLinkForbiddenException,
  RoomLinkNotFoundException,
} from './room-links.exceptions.js';
import { roomLinks } from './schema.js';

type Standing = 'admin' | 'staff' | 'member';

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
) as SQL;

const linkColumns = {
  code: roomLinks.code,
  title: roomLinks.title,
  cohortId: roomLinks.cohortId,
  spaceId: roomLinks.spaceId,
  spaceKey: spaces.key,
  spaceName: spaces.name,
  createdAt: roomLinks.createdAt,
};

type LinkRow = Omit<RoomLinkDto, 'url'>;

/**
 * Links to a space in one cohort's campus, one per event. Admins and the
 * cohort's professors and mentors make, list and revoke them; anybody with a
 * live place in the cohort, and any admin, opens one.
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
    now: Date = new Date(),
  ): Promise<RoomLinkDto> {
    await requireStaff(this.db, user, cohortId, now);
    await requireLiveSpace(this.db, spaceId);

    for (let attempt = 1; ; attempt++) {
      try {
        const [link] = await this.db
          .insert(roomLinks)
          .values({
            code: generateRoomLinkCode(),
            cohortId,
            spaceId,
            title,
            createdBy: user.id,
          })
          .returning({ code: roomLinks.code });
        return this.toDto(await this.find(link.code));
      } catch (err) {
        if (
          attempt < CODE_ATTEMPTS &&
          isUniqueViolation(err, 'room_links_code_unique')
        ) {
          continue;
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
      .orderBy(desc(roomLinks.createdAt));
    return rows.map((row) => this.toDto(row));
  }

  /**
   * Where a link leads. A revoked link, one to a space no longer on the entry map,
   * and one to a cohort the caller holds no place in are all a 404, so a code
   * says nothing to somebody it is not for.
   */
  async open(
    user: AuthenticatedUser,
    code: string,
    now: Date = new Date(),
  ): Promise<RoomLinkDto> {
    const link = await this.find(code);
    try {
      await standing(this.db, user, link.cohortId, now);
    } catch (err) {
      if (err instanceof RoomLinkForbiddenException) {
        throw notFound(code);
      }
      throw err;
    }
    return this.toDto(link);
  }

  /** Revoking a link already revoked changes nothing. */
  async revoke(
    user: AuthenticatedUser,
    code: string,
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
    await this.db
      .update(roomLinks)
      .set({ revokedAt: now })
      .where(and(eq(roomLinks.id, link.id), isNull(roomLinks.revokedAt)));
  }

  private async find(code: string): Promise<LinkRow> {
    const [link] = await this.db
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

  private toDto(row: LinkRow): RoomLinkDto {
    return {
      ...row,
      url: appUrl(this.config, `${ROOM_LINK_PATH}${row.code}`),
    };
  }
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
