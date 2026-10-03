import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { isLiveMembership } from '../cohorts/cohort-members.service.js';
import { cohortMembers, cohorts, cohortTracks } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import type { ListUsersQueryDto } from './dto/list-users.dto.js';
import type {
  UserListItemDto,
  UserMembershipDto,
} from './dto/user-list-item.dto.js';
import { users } from './schema.js';

/**
 * The admin's view of who has an account. Apart from UsersService on
 * purpose: that one is what sign-in resolves an identity with, and the
 * session layer depends on it; this one is admin tooling and nothing else
 * imports it.
 */
@Injectable()
export class UserDirectoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One page of users, newest first, each with their live memberships.
   *
   * Memberships are reported as the roster has them, whatever the account's
   * status. A suspended account cannot sign in — SessionGuard refuses it —
   * but it still holds its places, and an admin deciding what to do about a
   * suspension needs to see them. Access is `status`; this is the roster.
   *
   * Two reads rather than a join: a person can hold several memberships, so
   * joining would repeat them once per cohort and make `perPage` count rows
   * instead of people.
   */
  async list(
    query: ListUsersQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResponseDto<UserListItemDto>> {
    const filter = and(
      searchFilter(query.search),
      query.systemRole ? eq(users.systemRole, query.systemRole) : undefined,
      query.status ? eq(users.status, query.status) : undefined,
      this.membershipFilter(query, now),
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          systemRole: users.systemRole,
          status: users.status,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(filter)
        .orderBy(desc(users.createdAt), asc(users.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(users).where(filter),
    ]);

    const memberships = await this.liveMemberships(
      rows.map((row) => row.id),
      now,
    );

    return {
      items: rows.map((row) => ({
        ...row,
        memberships: memberships.get(row.id) ?? [],
      })),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  /**
   * The membership filters as one EXISTS, so they are all answered by the
   * same row: a mentor in this cohort, not somebody in this cohort who
   * mentors another.
   *
   * Live memberships only, by the definition sign-in uses — a person who
   * left a cohort is not in it. A suspended account's memberships count:
   * combine with `status` to leave those people out.
   */
  private membershipFilter(
    query: ListUsersQueryDto,
    now: Date,
  ): SQL | undefined {
    if (!query.cohortId && !query.trackId && !query.cohortRole) {
      return undefined;
    }

    return exists(
      this.db
        .select({ one: sql`1` })
        .from(cohortMembers)
        // Left, not inner: only students carry a track, and a cohort or
        // role filter on its own must still find everybody else.
        .leftJoin(
          cohortTracks,
          eq(cohortTracks.id, cohortMembers.cohortTrackId),
        )
        .where(
          and(
            eq(cohortMembers.userId, users.id),
            isLiveMembership(now),
            query.cohortId
              ? eq(cohortMembers.cohortId, query.cohortId)
              : undefined,
            query.trackId ? eq(cohortTracks.trackId, query.trackId) : undefined,
            query.cohortRole
              ? eq(cohortMembers.role, query.cohortRole)
              : undefined,
          ),
        ),
    );
  }

  /** Each listed person's live memberships, most recently joined first. */
  private async liveMemberships(
    userIds: string[],
    now: Date,
  ): Promise<Map<string, UserMembershipDto[]>> {
    const byUser = new Map<string, UserMembershipDto[]>();
    if (userIds.length === 0) {
      return byUser;
    }

    const rows = await this.db
      .select({
        userId: cohortMembers.userId,
        cohort: { id: cohorts.id, name: cohorts.name, code: cohorts.code },
        track: { id: tracks.id, name: tracks.name, code: tracks.code },
        role: cohortMembers.role,
        status: cohortMembers.status,
        joinedAt: cohortMembers.joinedAt,
        accessExpiresAt: cohortMembers.accessExpiresAt,
      })
      .from(cohortMembers)
      .innerJoin(cohorts, eq(cohorts.id, cohortMembers.cohortId))
      .leftJoin(cohortTracks, eq(cohortTracks.id, cohortMembers.cohortTrackId))
      .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .where(and(inArray(cohortMembers.userId, userIds), isLiveMembership(now)))
      // The order CohortMembersService lists a person's cohorts in.
      .orderBy(desc(cohortMembers.joinedAt), asc(cohortMembers.cohortId));

    for (const { userId, ...membership } of rows) {
      const list = byUser.get(userId) ?? [];
      list.push(membership);
      byUser.set(userId, list);
    }
    return byUser;
  }
}

/**
 * Any part of the address or a name, ignoring case. The full name is matched
 * as one string too, so "ada love" finds Ada Lovelace.
 */
function searchFilter(search: string | undefined): SQL | undefined {
  if (!search) {
    return undefined;
  }
  // The term is somebody's typing, not a pattern: % and _ match themselves.
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  return or(
    ilike(users.email, pattern),
    ilike(users.displayName, pattern),
    ilike(sql`concat_ws(' ', ${users.firstName}, ${users.lastName})`, pattern),
  );
}
