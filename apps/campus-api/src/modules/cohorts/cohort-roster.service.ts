import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { tracks } from '../tracks/schema.js';
import { users } from '../users/schema.js';
import {
  isLiveMembership,
  isNotLiveMembership,
} from './cohort-members.service.js';
import { CohortNotFoundException } from './cohorts.exceptions.js';
import {
  MembershipState,
  RosterScope,
  type ListRosterQueryDto,
  type RosterMemberDto,
} from './dto/cohort-roster.dto.js';
import { CohortRole, cohortMembers, cohorts, cohortTracks } from './schema.js';

/**
 * Who is in a cohort: the admin's roster. Apart from CohortMembersService,
 * which answers "may this person in" for the session layer and is imported
 * by it; this one is admin tooling and nothing else imports it.
 */
@Injectable()
export class CohortRosterService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One page of a cohort's memberships: by role, then by name.
   *
   * Live means what it means at sign-in, and is read against `now` rather
   * than off a column, so a guest whose visit has just ended is filed under
   * ended without anything having to flip a status first.
   *
   * A cohort that does not exist is a 404, unlike a filter that matches
   * nobody, which is an empty page: the caller named a cohort, and should
   * hear that it is not there.
   */
  async list(
    cohortId: string,
    query: ListRosterQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResponseDto<RosterMemberDto>> {
    const [cohort] = await this.db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId))
      .limit(1);
    if (!cohort) {
      throw new CohortNotFoundException(`Cohort ${cohortId} not found`, {
        cohortId,
      });
    }

    const live = isLiveMembership(now);
    const filter = and(
      eq(cohortMembers.cohortId, cohortId),
      scopeFilter(query.state, now),
      query.role ? eq(cohortMembers.role, query.role) : undefined,
      query.status ? eq(cohortMembers.status, query.status) : undefined,
      query.trackId ? eq(cohortTracks.trackId, query.trackId) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: cohortMembers.id,
          user: {
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            status: users.status,
          },
          role: cohortMembers.role,
          track: { id: tracks.id, name: tracks.name, code: tracks.code },
          status: cohortMembers.status,
          live: sql<boolean>`${live}`,
          dismissalReason: cohortMembers.dismissalReason,
          joinedAt: cohortMembers.joinedAt,
          leftAt: cohortMembers.leftAt,
          accessExpiresAt: cohortMembers.accessExpiresAt,
        })
        .from(cohortMembers)
        .innerJoin(users, eq(users.id, cohortMembers.userId))
        .leftJoin(
          cohortTracks,
          eq(cohortTracks.id, cohortMembers.cohortTrackId),
        )
        .leftJoin(tracks, eq(tracks.id, cohortTracks.trackId))
        .where(filter)
        // Staff, then students, then guests; by name within each; and the
        // id last, so a page boundary never repeats or drops a row.
        .orderBy(
          asc(ROLE_ORDER),
          asc(sql`lower(coalesce(${users.lastName}, ''))`),
          asc(sql`lower(coalesce(${users.firstName}, ''))`),
          asc(users.email),
          asc(cohortMembers.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db
        .select({ total: count() })
        .from(cohortMembers)
        // Joined here too: the track filter reads through it.
        .leftJoin(
          cohortTracks,
          eq(cohortTracks.id, cohortMembers.cohortTrackId),
        )
        .where(filter),
    ]);

    return {
      items: rows.map(({ live: isLive, ...row }) => ({
        ...row,
        state: isLive ? MembershipState.Live : MembershipState.Ended,
      })),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }
}

/**
 * Spelt out rather than left to the enum, which sorts in the order its
 * values were added: students first, and guests wherever a migration put
 * them.
 */
const ROLE_ORDER = sql`case ${cohortMembers.role}
  when ${sql.raw(`'${CohortRole.Professor}'`)} then 0
  when ${sql.raw(`'${CohortRole.Mentor}'`)} then 1
  when ${sql.raw(`'${CohortRole.Student}'`)} then 2
  else 3 end`;

function scopeFilter(scope: RosterScope, now: Date): SQL | undefined {
  switch (scope) {
    case RosterScope.Live:
      return isLiveMembership(now);
    case RosterScope.Ended:
      return isNotLiveMembership(now);
    case RosterScope.All:
      return undefined;
  }
}
