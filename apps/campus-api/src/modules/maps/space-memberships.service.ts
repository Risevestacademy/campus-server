import { isLiveGrant, type SpaceGrantFacts } from '@campus/space-access';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import {
  DRIZZLE,
  type Db,
  type Tx,
} from '../../infra/database/database.constants.js';
import type { AuditContext } from '../audit/audit-log.js';
import { writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { CohortRole, cohorts, cohortTracks } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import { SystemRole, users } from '../users/schema.js';
import type {
  GrantSpaceMembershipDto,
  SpaceMembershipResponseDto,
  SpaceMembershipSubjectDto,
} from './dto/space-membership.dto.js';
import { SpaceMembershipSubjectType } from './dto/space-membership.dto.js';
import {
  SpaceMembershipAlreadyEndedException,
  SpaceMembershipAlreadyLiveException,
  SpaceMembershipInvalidArgumentException,
  SpaceMembershipNotFoundException,
  SpaceMembershipNotStartedException,
  SpaceMembershipSubjectNotFoundException,
  SpaceNotFoundException,
  SpaceRetiredException,
} from './maps.exceptions.js';
import { spaceMemberships, spaces } from './schema.js';
import { tellWorld } from './tell-world.js';

/**
 * A membership row as the shared rule reads it: the span, and who it is to.
 * The row's own columns under the package's names, so nothing has to think
 * about which is which — the window question belongs to @campus/space-access
 * and the subject matching too, and this is the only place the two namings
 * are allowed to meet.
 */
function windowOf(row: {
  userId: string | null;
  cohortTrackId: string | null;
  cohortRole: string | null;
  systemRole: string | null;
  validFrom: Date;
  validTo: Date | null;
}): SpaceGrantFacts {
  return {
    toUserId: row.userId,
    toTrackId: row.cohortTrackId,
    toCohortRole: row.cohortRole,
    toSystemRole: row.systemRole,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

/**
 * Whether a grant is over: its span closed at or before `at`. Not the same
 * question as `isLiveGrant` — a grant that has not started yet is not live,
 * and not ended either.
 */
function hasEnded<T extends { validTo: Date | null }>(
  row: T,
  at: Date,
): row is T & { validTo: Date } {
  return row.validTo !== null && row.validTo.getTime() <= at.getTime();
}

/** What became of a track's grants when it was taken off its cohort. */
export type TrackGrantRelease =
  | { released: true; clearedIds: string[] }
  | { released: false; standingSpaceIds: string[] };

/**
 * The grants side of detaching a track from its cohort
 * (CohortsService.detachTrack), run in the detach's own transaction after it
 * has locked the cohort's link to the track.
 *
 * A grant that has not ended keeps the track where it is: taking the track
 * off would take that access away without anyone ending it, so nothing is
 * deleted and the spaces it opens are named. Otherwise the ended grants go —
 * kept for good they would hold the link, and so the cohort, forever — and
 * the audit log, which has each one's granting and ending, is their record.
 */
export async function releaseTrackGrants(
  tx: Tx,
  cohortTrackId: string,
  now: Date,
): Promise<TrackGrantRelease> {
  const held = await tx
    .select({
      id: spaceMemberships.id,
      spaceId: spaceMemberships.spaceId,
      validTo: spaceMemberships.validTo,
    })
    .from(spaceMemberships)
    .where(eq(spaceMemberships.cohortTrackId, cohortTrackId));

  const standing = held.filter((row) => !hasEnded(row, now));
  if (standing.length > 0) {
    return {
      released: false,
      standingSpaceIds: [...new Set(standing.map((row) => row.spaceId))],
    };
  }

  const cleared = await tx
    .delete(spaceMemberships)
    .where(eq(spaceMemberships.cohortTrackId, cohortTrackId))
    .returning({ id: spaceMemberships.id });
  return { released: true, clearedIds: cleared.map((row) => row.id) };
}

/** How a refusal names the subject that already holds a live grant. */
const HOLDER: Record<SpaceMembershipSubjectType, string> = {
  [SpaceMembershipSubjectType.User]: 'That person',
  [SpaceMembershipSubjectType.CohortTrack]: 'That track',
  [SpaceMembershipSubjectType.CohortRole]: 'That cohort role',
  [SpaceMembershipSubjectType.SystemRole]: 'That system role',
};

/**
 * Granting and ending access to a space, and reading who has it: the
 * entries on a designated space's list, which `mayEnter` in
 * @campus/space-access counts between their start and their end. An entry
 * on a normal space is taken but does nothing there; it counts if an admin
 * later makes the space designated.
 *
 * Every write is one transaction of row plus audit entry, so the log never
 * claims something that did not happen nor misses something that did.
 */
@Injectable()
export class SpaceMembershipsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Give a person, or everybody on one cohort track, standing access.
   *
   * The space's row is locked before anything is judged, and held to the end
   * of the transaction: two grants for one space are checked one after the
   * other, so two requests arriving together cannot both find nothing live
   * and both write. The database cannot hold this rule itself — "still live"
   * is a question about now, and a partial unique index may only name
   * immutable conditions, so `now()` is refused in one — which is why the
   * lock, not an index, is what makes the check true under concurrency.
   * `no key update` rather than `update`: two grants still take turns, but
   * a row elsewhere that only references the space — an audit entry naming
   * it — is not held up behind the grant.
   */
  async grant(
    spaceId: string,
    dto: GrantSpaceMembershipDto,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<SpaceMembershipResponseDto> {
    const userId = dto.userId ?? null;
    const cohortTrackId = dto.cohortTrackId ?? null;
    const cohortRole = dto.cohortRole ?? null;
    const systemRole = dto.systemRole ?? null;
    const named = [userId, cohortTrackId, cohortRole, systemRole].filter(
      (subject) => subject !== null,
    );
    if (named.length !== 1) {
      throw new SpaceMembershipInvalidArgumentException(
        'A grant is to exactly one of a person, a cohort track, a cohort role or a system role',
        { userId, cohortTrackId, cohortRole, systemRole },
      );
    }
    const validTo = dto.validTo === undefined ? null : new Date(dto.validTo);
    if (validTo !== null && validTo.getTime() <= now.getTime()) {
      throw new SpaceMembershipInvalidArgumentException(
        'The end date has to be in the future',
        { validTo: dto.validTo },
      );
    }

    return await this.db.transaction(async (tx) => {
      const [space] = await tx
        .select()
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for('no key update');
      if (!space) {
        throw new SpaceNotFoundException(`No space with id ${spaceId}`);
      }
      if (space.retiredAt !== null) {
        throw new SpaceRetiredException(
          `Space ${spaceId} is retired, and no access is granted to it`,
          { retiredAt: space.retiredAt },
        );
      }

      const subject = await (async (): Promise<SpaceMembershipSubjectDto> => {
        // A role needs nothing looked up: the enum is the whole of it.
        if (cohortRole !== null) {
          return { type: SpaceMembershipSubjectType.CohortRole, cohortRole };
        }
        if (systemRole !== null) {
          return { type: SpaceMembershipSubjectType.SystemRole, systemRole };
        }
        if (userId !== null) {
          const [user] = await tx
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!user) {
            throw new SpaceMembershipSubjectNotFoundException(
              `No account with id ${userId}`,
            );
          }
          return {
            type: SpaceMembershipSubjectType.User,
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
          };
        }
        // A cohort track row exists only under a cohort that runs it, so the
        // join is the refusal for "no cohort runs that track": there is no
        // id to find. The columns come along for the answer's sake.
        //
        // Held with `key share` to the end, as a member's move holds it: a
        // detach of the track locks the row before it looks for grants, so
        // if this went first the detach waits and then sees the grant, and
        // if the detach went first this finds no row and answers 404.
        const [track] = await tx
          .select({
            id: cohortTracks.id,
            cohortId: cohorts.id,
            cohortName: cohorts.name,
            trackName: tracks.name,
            trackCode: tracks.code,
          })
          .from(cohortTracks)
          .innerJoin(cohorts, eq(cohortTracks.cohortId, cohorts.id))
          .innerJoin(tracks, eq(cohortTracks.trackId, tracks.id))
          .where(eq(cohortTracks.id, cohortTrackId as string))
          .limit(1)
          .for('key share', { of: cohortTracks });
        if (!track) {
          throw new SpaceMembershipSubjectNotFoundException(
            `No cohort runs a track with id ${cohortTrackId}`,
            { cohortTrackId },
          );
        }
        return {
          type: SpaceMembershipSubjectType.CohortTrack,
          cohortTrackId: track.id,
          trackName: track.trackName,
          trackCode: track.trackCode,
          cohortId: track.cohortId,
          cohortName: track.cohortName,
        };
      })();

      const held = await tx
        .select()
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.spaceId, spaceId),
            userId !== null
              ? eq(spaceMemberships.userId, userId)
              : cohortTrackId !== null
                ? eq(spaceMemberships.cohortTrackId, cohortTrackId)
                : cohortRole !== null
                  ? eq(spaceMemberships.cohortRole, cohortRole)
                  : eq(spaceMemberships.systemRole, systemRole as SystemRole),
          ),
        );
      const live = held.find((row) => isLiveGrant(windowOf(row), now));
      if (live) {
        throw new SpaceMembershipAlreadyLiveException(
          `${HOLDER[subject.type]} already holds a live grant on this space`,
          { membershipId: live.id, validTo: live.validTo },
        );
      }

      const [row] = await tx
        .insert(spaceMemberships)
        .values({
          spaceId,
          userId,
          cohortTrackId,
          cohortRole,
          systemRole,
          grantedBy: audit.actorUserId,
          validFrom: now,
          validTo,
        })
        .returning();

      await tellWorld(tx);
      await writeAuditEntry(tx, {
        ...audit,
        spaceId,
        action: AuditAction.SpaceMembershipGranted,
        subject: { type: AuditSubjectType.SpaceMembership, id: row.id },
        details: {
          userId: row.userId,
          cohortTrackId: row.cohortTrackId,
          cohortRole: row.cohortRole,
          systemRole: row.systemRole,
          validFrom: row.validFrom,
          validTo: row.validTo,
        },
      });

      return {
        id: row.id,
        spaceId: row.spaceId,
        subject,
        grantedBy: row.grantedBy,
        validFrom: row.validFrom,
        validTo: row.validTo,
        live: isLiveGrant(windowOf(row), now),
      };
    });
  }

  /**
   * Bring a grant to an end: `valid_to` is set to now and the row stays as
   * the record that it existed — until, for a grant to a track, the track
   * is detached from its cohort (releaseTrackGrants), and the audit log is
   * the record from then on. The grant's own row is locked, so two ends of
   * it take turns — the second is told it is already over rather than
   * moving the record a second time.
   */
  async end(
    spaceId: string,
    membershipId: string,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.id, membershipId),
            eq(spaceMemberships.spaceId, spaceId),
          ),
        )
        .for('update');
      if (!row) {
        throw new SpaceMembershipNotFoundException(
          `No grant ${membershipId} on space ${spaceId}`,
        );
      }
      if (hasEnded(row, now)) {
        throw new SpaceMembershipAlreadyEndedException(
          `That grant already ended at ${row.validTo.toISOString()}`,
          { validTo: row.validTo },
        );
      }
      if (row.validFrom.getTime() > now.getTime()) {
        // Ending closes a window at now, and the window rule keeps a close
        // after its open: a grant that has not started cannot be closed
        // without rewriting when it began. No route makes one — a grant
        // starts when it is given — so this is for rows written another way.
        throw new SpaceMembershipNotStartedException(
          `That grant has not started yet; it runs from ${row.validFrom.toISOString()}`,
          { validFrom: row.validFrom },
        );
      }
      // A grant opened and ended within the same millisecond would close at
      // its own start, and `valid_to > valid_from` says no — a refusal for a
      // perfectly sound sequence. One tick past the open keeps the row valid
      // and the record true: it was live for that tick, and no more.
      const closedAt = new Date(
        Math.max(now.getTime(), row.validFrom.getTime() + 1),
      );

      await tx
        .update(spaceMemberships)
        .set({ validTo: closedAt })
        .where(eq(spaceMemberships.id, row.id));

      await tellWorld(tx);
      await writeAuditEntry(tx, {
        ...audit,
        spaceId,
        action: AuditAction.SpaceMembershipEnded,
        subject: { type: AuditSubjectType.SpaceMembership, id: row.id },
        details: { endedAt: closedAt },
      });
    });
  }

  /**
   * Every grant on the space, ended ones included: the ended rows are the
   * record of who had access and when — short of a track's ended grants,
   * which go when the track is detached from its cohort — and `live` says
   * which count right now. Ordered by when they began, earliest first.
   */
  async list(
    spaceId: string,
    now: Date = new Date(),
  ): Promise<SpaceMembershipResponseDto[]> {
    const [space] = await this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
    if (!space) {
      throw new SpaceNotFoundException(`No space with id ${spaceId}`);
    }

    const rows = await this.db
      .select({
        id: spaceMemberships.id,
        spaceId: spaceMemberships.spaceId,
        userId: spaceMemberships.userId,
        cohortTrackId: spaceMemberships.cohortTrackId,
        cohortRole: spaceMemberships.cohortRole,
        systemRole: spaceMemberships.systemRole,
        grantedBy: spaceMemberships.grantedBy,
        validFrom: spaceMemberships.validFrom,
        validTo: spaceMemberships.validTo,
        email: users.email,
        displayName: users.displayName,
        trackName: tracks.name,
        trackCode: tracks.code,
        cohortId: cohorts.id,
        cohortName: cohorts.name,
      })
      .from(spaceMemberships)
      // Left joins because only one subject is ever set: a person's entry
      // fills the user columns, a track's the track and cohort ones, and a
      // role's none of them; every row comes back in one query either way.
      .leftJoin(users, eq(spaceMemberships.userId, users.id))
      .leftJoin(
        cohortTracks,
        eq(spaceMemberships.cohortTrackId, cohortTracks.id),
      )
      .leftJoin(cohorts, eq(cohortTracks.cohortId, cohorts.id))
      .leftJoin(tracks, eq(cohortTracks.trackId, tracks.id))
      .where(eq(spaceMemberships.spaceId, spaceId))
      .orderBy(asc(spaceMemberships.validFrom), asc(spaceMemberships.id));

    return rows.map((row) => ({
      id: row.id,
      spaceId: row.spaceId,
      subject: subjectOf(row),
      grantedBy: row.grantedBy,
      validFrom: row.validFrom,
      validTo: row.validTo,
      live: isLiveGrant(windowOf(row), now),
    }));
  }
}

/** Which subject a listed row names, with what there is to say about it. */
function subjectOf(row: {
  userId: string | null;
  cohortTrackId: string | null;
  cohortRole: CohortRole | null;
  systemRole: SystemRole | null;
  email: string | null;
  displayName: string | null;
  trackName: string | null;
  trackCode: string | null;
  cohortId: string | null;
  cohortName: string | null;
}): SpaceMembershipSubjectDto {
  if (row.userId !== null) {
    return {
      type: SpaceMembershipSubjectType.User,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
    };
  }
  if (row.cohortTrackId !== null) {
    return {
      type: SpaceMembershipSubjectType.CohortTrack,
      cohortTrackId: row.cohortTrackId,
      trackName: row.trackName,
      trackCode: row.trackCode,
      cohortId: row.cohortId as string,
      cohortName: row.cohortName,
    };
  }
  if (row.cohortRole !== null) {
    return {
      type: SpaceMembershipSubjectType.CohortRole,
      cohortRole: row.cohortRole,
    };
  }
  return {
    type: SpaceMembershipSubjectType.SystemRole,
    systemRole: row.systemRole as SystemRole,
  };
}
