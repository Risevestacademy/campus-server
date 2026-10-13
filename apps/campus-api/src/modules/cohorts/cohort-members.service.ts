import { Inject, Injectable } from '@nestjs/common';
import { type SQL, and, eq, gt, isNull, ne, not, or, sql } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { type AuditContext, writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { tracks } from '../tracks/schema.js';
import { TrackNotFoundException } from '../tracks/tracks.exceptions.js';
import {
  CohortConflictException,
  CohortInvalidArgumentException,
  CohortMemberNotFoundException,
} from './cohorts.exceptions.js';
import type { CohortMemberResponseDto } from './dto/cohort-response.dto.js';
import type { MoveMemberTrackResponseDto } from './dto/move-track.dto.js';
import {
  CohortRole,
  StudentStatus,
  cohortMembers,
  cohorts,
  cohortTracks,
} from './schema.js';

/**
 * What a live place on the roster is, as one expression.
 *
 * Every consumer asks the same question and must get the same answer: the
 * sign-in gate deciding whether somebody may in without an invite, and
 * enrolment deciding whether a row may be revived. When those two disagreed
 * the gap was a permanent lockout — a dismissed student counted as inactive
 * at sign-in but still blocked the invite meant to bring them back, so they
 * could neither get in nor accept.
 *
 * Staff qualify on role alone, since status is the student half of the table
 * and they never carry one. A student qualifies only while explicitly
 * active: a row left unclassified is a half-finished enrolment, not a
 * standing invitation. A guest qualifies until their visit ends.
 *
 * `is not distinct from` rather than `=`, because a NULL status would make
 * the comparison NULL rather than false, and this predicate is negated by
 * enrolment — where NULL would silently refuse to revive.
 */
export function isLiveMembership(now: Date): SQL<unknown> {
  return and(
    isNull(cohortMembers.leftAt),
    or(
      ne(cohortMembers.role, CohortRole.Student),
      sql`${cohortMembers.status} is not distinct from ${sql.raw(`'${StudentStatus.Active}'`)}`,
    ),
    or(
      isNull(cohortMembers.accessExpiresAt),
      gt(cohortMembers.accessExpiresAt, now),
    ),
  ) as SQL<unknown>;
}

/** The negation, for callers that want the rows a live one would exclude. */
export function isNotLiveMembership(now: Date): SQL<unknown> {
  return not(isLiveMembership(now));
}

/**
 * Somebody's standing on the roster: that they have one, and when the last
 * of it runs out. Null `endsAt` means at least one thing they hold does not
 * expire, so nothing bounds a session minted against it.
 */
export interface AccessGrant {
  endsAt: Date | null;
}

export interface SessionMembership {
  role: CohortRole;
  cohortId: string;
}

/** A live membership with what a cohort picker needs to label it. */
export interface CohortPlace extends SessionMembership {
  cohort: { name: string; code: string };
}

@Injectable()
export class CohortMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Whether this account may sign in without an invite, and the deadline
   * that goes with it — from one query, so the two cannot disagree.
   *
   * Returning them together is the point. Asking "are they active?" and then
   * separately "when do they expire?" reads the clock twice, and a guest who
   * crosses their deadline between the two answers looks active to the first
   * and unexpiring to the second, which is a full-length session for a visit
   * that has ended.
   */
  async resolveActiveAccess(
    userId: string,
    now: Date = new Date(),
  ): Promise<AccessGrant | null> {
    const rows = await this.db
      .select({ endsAt: cohortMembers.accessExpiresAt })
      .from(cohortMembers)
      .where(and(eq(cohortMembers.userId, userId), isLiveMembership(now)))
      // Access lasts while ANY live membership does, so the bound is the
      // last one to end — not the first. `desc nulls first` returns null
      // whenever some membership has no deadline at all, which is the case
      // where nothing bounds the session: a professor who is also a guest
      // somewhere keeps their professor's access after the visit ends.
      .orderBy(sql`${cohortMembers.accessExpiresAt} desc nulls first`)
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : { endsAt: row.endsAt };
  }

  /** A live place on the roster — see resolveActiveAccess for the deadline. */
  async hasActiveMembership(
    userId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    return (await this.resolveActiveAccess(userId, now)) !== null;
  }

  /**
   * Every cohort this account may enter now, most recently joined first. A
   * person can belong to several at once, in any mix of roles, and picks
   * which one to enter.
   */
  async listActiveMemberships(
    userId: string,
    now: Date = new Date(),
  ): Promise<CohortPlace[]> {
    const rows = await this.db
      .select({
        cohortId: cohortMembers.cohortId,
        role: cohortMembers.role,
        name: cohorts.name,
        code: cohorts.code,
      })
      .from(cohortMembers)
      .innerJoin(cohorts, eq(cohorts.id, cohortMembers.cohortId))
      .where(and(eq(cohortMembers.userId, userId), isLiveMembership(now)))
      // Most recently joined first, `cohortId` breaking ties on the same
      // instant so the order is stable between reads.
      .orderBy(sql`${cohortMembers.joinedAt} desc`, cohortMembers.cohortId);

    return rows.map(({ cohortId, role, name, code }) => ({
      cohortId,
      role,
      cohort: { name, code },
    }));
  }

  /**
   * Moves the end of a guest's visit forward, so the session they already
   * hold runs to the new deadline from their next refresh — no sign-in, no
   * new link, and nothing for them to do.
   *
   * A visit that has already ended is refused with a 409 rather than moved.
   * The guest accepted a link with a deadline on it, and bringing them back
   * is what an invite records (`invite_created`, `invite_resent`); reopening
   * it here would hand back access the deadline had closed, with no entry
   * saying they were asked back.
   *
   * The row is read under a lock: two extensions racing must not both judge
   * themselves against the same deadline and store the earlier of the two.
   * The entry is written in the same transaction, so a visit is never
   * extended without its record.
   */
  async extendGuestVisit(
    cohortId: string,
    userId: string,
    accessExpiresAt: Date,
    audit: AuditContext,
    now: Date = new Date(),
  ): Promise<CohortMemberResponseDto> {
    // The route's check passes ISO forms Date cannot read — a week date
    // like 2026-W43-2, or 20261020 — and an invalid Date compares false
    // against everything below, so it would reach the UPDATE and fail there.
    if (Number.isNaN(accessExpiresAt.getTime())) {
      throw new CohortInvalidArgumentException('Request validation failed', {
        fields: {
          accessExpiresAt:
            'accessExpiresAt is not a date: use a form like 2026-11-30T17:00:00Z',
        },
      });
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(cohortMembers)
        .where(
          and(
            eq(cohortMembers.cohortId, cohortId),
            eq(cohortMembers.userId, userId),
          ),
        )
        .for('update');
      if (!existing) {
        throw new CohortMemberNotFoundException(
          `No membership for ${userId} in cohort ${cohortId}`,
          { cohortId, userId },
        );
      }
      if (existing.leftAt !== null) {
        throw new CohortConflictException('That membership has already ended', {
          cohortId,
          userId,
          leftAt: existing.leftAt,
        });
      }
      if (existing.role !== CohortRole.Guest) {
        throw new CohortConflictException(
          'Only a guest has a visit to extend',
          { cohortId, userId, role: existing.role },
        );
      }
      // The schema makes an end date part of being a guest, so null here
      // would be a row the schema could not have written; the visit running
      // out is the case that exists.
      const previousEnd = existing.accessExpiresAt;
      if (previousEnd === null || previousEnd.getTime() <= now.getTime()) {
        throw new CohortConflictException(
          'The visit has already ended; send a new invite',
          {
            cohortId,
            userId,
            accessExpiresAt: previousEnd,
          },
        );
      }
      if (accessExpiresAt.getTime() <= now.getTime()) {
        throw new CohortInvalidArgumentException('Request validation failed', {
          fields: { accessExpiresAt: 'accessExpiresAt must be in the future' },
        });
      }
      if (accessExpiresAt.getTime() <= previousEnd.getTime()) {
        throw new CohortInvalidArgumentException('Request validation failed', {
          fields: {
            accessExpiresAt:
              'accessExpiresAt must be later than the visit end it already has',
          },
        });
      }

      const [row] = await tx
        .update(cohortMembers)
        .set({ accessExpiresAt })
        .where(eq(cohortMembers.id, existing.id))
        .returning();
      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.GuestVisitExtended,
        subject: { type: AuditSubjectType.CohortMember, id: row.id },
        details: {
          cohortId,
          accessExpiresAt,
          previousAccessExpiresAt: previousEnd,
        },
      });

      return {
        id: row.id,
        cohortId: row.cohortId,
        userId: row.userId,
        role: row.role,
        // Straight back what was written: the row repeats it as nullable,
        // and a guest's is never null.
        accessExpiresAt,
      };
    });
  }

  /**
   * Moves a student to another track the same cohort runs.
   *
   * One row, one transaction: the track the membership is on is replaced and
   * the entry appended together, so neither lands without the other. The row
   * is read under a lock, so two moves racing each see the track the other
   * left rather than both deciding against the same one.
   *
   * Only a student has a track to move: staff and guests are refused with a
   * 409. The target has to be a track this cohort actually runs — one another
   * cohort runs is refused, and a track id that names nothing is a 404 — and
   * the move has to change something, so the track they are already on is a
   * 409 too. Nothing about the membership but its track is touched: status,
   * end date and joined date stay as they were.
   *
   * Refusals: no such membership is a 404; one that has ended, is not a
   * student, is already on the target, or names a track this cohort does not
   * run is a 409; a track id that names no catalogue track is a 404.
   */
  async moveMemberTrack(
    cohortId: string,
    userId: string,
    trackId: string,
    audit: AuditContext,
  ): Promise<MoveMemberTrackResponseDto> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(cohortMembers)
        .where(
          and(
            eq(cohortMembers.cohortId, cohortId),
            eq(cohortMembers.userId, userId),
          ),
        )
        .for('update');
      if (!existing) {
        throw new CohortMemberNotFoundException(
          `No membership for ${userId} in cohort ${cohortId}`,
          { cohortId, userId },
        );
      }
      if (existing.leftAt !== null) {
        throw new CohortConflictException('That membership has already ended', {
          cohortId,
          userId,
          leftAt: existing.leftAt,
        });
      }
      if (existing.role !== CohortRole.Student) {
        throw new CohortConflictException(
          'Only a student has a track to move',
          {
            cohortId,
            userId,
            role: existing.role,
          },
        );
      }

      // The catalogue track, then the cohort's own link to it. Checked in
      // that order so an id that names nothing is its own 404, while a real
      // track this cohort does not run is the conflict it is.
      const [track] = await tx
        .select()
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .limit(1);
      if (!track) {
        throw new TrackNotFoundException(`Track ${trackId} not found`, {
          trackId,
        });
      }
      const [link] = await tx
        .select()
        .from(cohortTracks)
        .where(
          and(
            eq(cohortTracks.cohortId, cohortId),
            eq(cohortTracks.trackId, trackId),
          ),
        )
        .limit(1);
      if (!link) {
        throw new CohortConflictException(
          `Track ${track.code} is not run by this cohort`,
          { cohortId, trackId },
        );
      }
      if (existing.cohortTrackId === link.id) {
        throw new CohortConflictException(
          `The student is already on track ${track.code}`,
          { cohortId, userId, trackId },
        );
      }

      // What the entry records the move replaced. The CHECK makes a
      // student's track non-null, so this is only null for a row the schema
      // could not have written; read it rather than assume.
      let previousTrackId: string | null = null;
      if (existing.cohortTrackId !== null) {
        const [previousLink] = await tx
          .select({ trackId: cohortTracks.trackId })
          .from(cohortTracks)
          .where(eq(cohortTracks.id, existing.cohortTrackId))
          .limit(1);
        previousTrackId = previousLink?.trackId ?? null;
      }

      const [row] = await tx
        .update(cohortMembers)
        .set({ cohortTrackId: link.id })
        .where(eq(cohortMembers.id, existing.id))
        .returning();
      await writeAuditEntry(tx, {
        ...audit,
        action: AuditAction.MemberTrackChanged,
        subject: { type: AuditSubjectType.CohortMember, id: row.id },
        details: { cohortId, trackId, previousTrackId },
      });

      return {
        id: row.id,
        cohortId: row.cohortId,
        userId: row.userId,
        role: row.role,
        track: { id: track.id, name: track.name, code: track.code },
      };
    });
  }
}
