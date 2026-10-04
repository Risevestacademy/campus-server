import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import {
  type AuditContext,
  changedFields,
  writeAuditEntry,
} from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { tracks } from '../tracks/schema.js';
import { TrackNotFoundException } from '../tracks/tracks.exceptions.js';
import {
  CohortConflictException,
  CohortInvalidArgumentException,
  CohortNotFoundException,
} from './cohorts.exceptions.js';
import type {
  CohortDetailResponseDto,
  CohortTrackResponseDto,
} from './dto/cohort-response.dto.js';
import type { CreateCohortDto } from './dto/create-cohort.dto.js';
import type { UpdateCohortDto } from './dto/update-cohort.dto.js';
import { cohorts, cohortTracks, type Cohort } from './schema.js';

/** What an admin can edit on a cohort, and so what an update entry compares. */
const COHORT_AUDITED_FIELDS = [
  'name',
  'code',
  'startDate',
  'endDate',
  'status',
] as const;

/**
 * Creating cohorts and choosing which tracks each one runs — the setup an
 * invite needs before it can name a cohort and a cohortTrackId. Membership
 * lives in CohortMembersService, which the session layer depends on; this
 * one is admin tooling and nothing else imports it.
 */
@Injectable()
export class CohortsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(dto: CreateCohortDto, audit: AuditContext): Promise<Cohort> {
    try {
      // One transaction, so a cohort is never created without its entry.
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(cohorts)
          .values({
            name: dto.name,
            code: dto.code,
            startDate: dto.startDate ?? null,
            endDate: dto.endDate ?? null,
            status: dto.status,
          })
          .returning();
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.CohortCreated,
          subject: { type: AuditSubjectType.Cohort, id: row.id },
          details: {
            name: row.name,
            code: row.code,
            status: row.status,
            startDate: row.startDate,
            endDate: row.endDate,
          },
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'cohorts_code_unique')) {
        throw new CohortConflictException(
          `A cohort with code ${dto.code} already exists`,
          { code: dto.code },
        );
      }
      throw err;
    }
  }

  async list(query: PaginationQueryDto): Promise<PaginatedResponseDto<Cohort>> {
    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(cohorts)
        .orderBy(desc(cohorts.createdAt), asc(cohorts.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(cohorts),
    ]);

    return {
      items,
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  }

  async get(id: string): Promise<CohortDetailResponseDto> {
    const cohort = await this.findCohort(id);

    const rows = await this.db
      .select({ link: cohortTracks, track: tracks })
      .from(cohortTracks)
      .innerJoin(tracks, eq(cohortTracks.trackId, tracks.id))
      .where(eq(cohortTracks.cohortId, id))
      .orderBy(asc(tracks.name), asc(cohortTracks.id));

    return {
      ...cohort,
      tracks: rows.map(({ link, track }) => ({
        id: link.id,
        cohortId: link.cohortId,
        track,
        createdAt: link.createdAt,
      })),
    };
  }

  async attachTrack(
    cohortId: string,
    trackId: string,
    audit: AuditContext,
  ): Promise<CohortTrackResponseDto> {
    await this.findCohort(cohortId);
    const [track] = await this.db
      .select()
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (!track) {
      throw new TrackNotFoundException(`Track ${trackId} not found`, {
        trackId,
      });
    }

    try {
      const link = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(cohortTracks)
          .values({ cohortId, trackId })
          .returning();
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.CohortTrackAttached,
          subject: { type: AuditSubjectType.CohortTrack, id: row.id },
          details: { cohortId, trackId },
        });
        return row;
      });
      return {
        id: link.id,
        cohortId: link.cohortId,
        track,
        createdAt: link.createdAt,
      };
    } catch (err) {
      // A 409 rather than handing back the existing row: attaching twice
      // is almost always a mistake worth hearing about, and the row is one
      // GET /v1/cohorts/{id} away.
      if (isUniqueViolation(err, 'cohort_tracks_track_id_cohort_id_key')) {
        throw new CohortConflictException(
          `Track ${track.code} is already attached to this cohort`,
          { cohortId, trackId },
        );
      }
      // Both were found above, so this is one deleted between that read and
      // the insert: the same 404 the read would have given a moment later.
      if (isForeignKeyViolation(err, 'cohort_tracks_cohort_id_cohorts_id_fk')) {
        throw new CohortNotFoundException(`Cohort ${cohortId} not found`, {
          cohortId,
        });
      }
      if (isForeignKeyViolation(err, 'cohort_tracks_track_id_tracks_id_fk')) {
        throw new TrackNotFoundException(`Track ${trackId} not found`, {
          trackId,
        });
      }
      throw err;
    }
  }

  /**
   * Stops a cohort running a track. The reverse of attachTrack, and what a
   * cohort needs before it can be deleted.
   *
   * Refused while anything in the cohort is still on the track: a student
   * placed on it, or an invite that names it, pending or settled. The FKs
   * are restrictive on purpose — detaching must not quietly leave a student
   * with no track, or an invite pointing at nothing — so those have to be
   * moved or removed first.
   */
  async detachTrack(
    cohortId: string,
    trackId: string,
    audit: AuditContext,
  ): Promise<void> {
    // Read first, so a missing cohort and a track that is simply not
    // attached get different answers.
    await this.findCohort(cohortId);

    try {
      // One transaction, so a track is never detached without its entry, and
      // a detach the FKs refuse leaves no entry behind.
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(cohortTracks)
          .where(
            and(
              eq(cohortTracks.cohortId, cohortId),
              eq(cohortTracks.trackId, trackId),
            ),
          )
          .returning();
        if (!row) {
          throw new TrackNotFoundException(
            `Track ${trackId} is not attached to this cohort`,
            { cohortId, trackId },
          );
        }
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.CohortTrackDetached,
          subject: { type: AuditSubjectType.CohortTrack, id: row.id },
          details: { cohortId, trackId },
        });
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new CohortConflictException(
          'Track cannot be detached while students or invites in this cohort are still on it',
          { cohortId, trackId },
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateCohortDto,
    audit: AuditContext,
  ): Promise<Cohort> {
    try {
      return await this.db.transaction(async (tx) => {
        // Locked, so the range check below and the write it guards see the
        // same row. Unlocked, two edits each moving one date could both pass
        // against the old pair and together store an end before the start.
        const [existing] = await tx
          .select()
          .from(cohorts)
          .where(eq(cohorts.id, id))
          .for('update');
        if (!existing) {
          throw new CohortNotFoundException(`Cohort ${id} not found`, {
            cohortId: id,
          });
        }

        // The DTO checks each date on its own; only the merged pair can say
        // whether a one-sided change inverts the range.
        const startDate =
          dto.startDate === undefined
            ? existing.startDate
            : (dto.startDate ?? null);
        const endDate =
          dto.endDate === undefined ? existing.endDate : (dto.endDate ?? null);
        if (startDate !== null && endDate !== null && endDate < startDate) {
          throw new CohortInvalidArgumentException(
            'Request validation failed',
            { fields: { endDate: 'endDate must be on or after startDate' } },
          );
        }

        if (
          dto.name === undefined &&
          dto.code === undefined &&
          dto.startDate === undefined &&
          dto.endDate === undefined &&
          dto.status === undefined
        ) {
          return existing;
        }

        const [row] = await tx
          .update(cohorts)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.startDate !== undefined ? { startDate } : {}),
            ...(dto.endDate !== undefined ? { endDate } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          })
          .where(eq(cohorts.id, id))
          .returning();

        const changes = changedFields(existing, row, COHORT_AUDITED_FIELDS);
        if (Object.keys(changes).length > 0) {
          await writeAuditEntry(tx, {
            ...audit,
            action: AuditAction.CohortUpdated,
            subject: { type: AuditSubjectType.Cohort, id },
            details: { changes },
          });
        }
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'cohorts_code_unique')) {
        throw new CohortConflictException(
          `A cohort with code ${dto.code} already exists`,
          { code: dto.code },
        );
      }
      throw err;
    }
  }

  async remove(id: string, audit: AuditContext): Promise<void> {
    try {
      // One transaction, so a cohort is never deleted without its entry, and
      // a delete the FKs refuse leaves no entry behind.
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(cohorts)
          .where(eq(cohorts.id, id))
          .returning();
        if (!row) {
          throw new CohortNotFoundException(`Cohort ${id} not found`, {
            cohortId: id,
          });
        }
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.CohortDeleted,
          subject: { type: AuditSubjectType.Cohort, id },
          details: {
            name: row.name,
            code: row.code,
            status: row.status,
            startDate: row.startDate,
            endDate: row.endDate,
          },
        });
      });
    } catch (err) {
      // The FKs are restrictive on purpose: a cohort with tracks, members
      // or invites is refused rather than emptied, so the message says what
      // has to go first. Tracks come off with detachTrack.
      if (isForeignKeyViolation(err)) {
        throw new CohortConflictException(
          'Cohort cannot be deleted while it still has tracks, members or invites',
          { cohortId: id },
        );
      }
      throw err;
    }
  }

  private async findCohort(id: string): Promise<Cohort> {
    const [cohort] = await this.db
      .select()
      .from(cohorts)
      .where(eq(cohorts.id, id))
      .limit(1);
    if (!cohort) {
      throw new CohortNotFoundException(`Cohort ${id} not found`, {
        cohortId: id,
      });
    }
    return cohort;
  }
}
