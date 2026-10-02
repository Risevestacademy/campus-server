import { Inject, Injectable } from '@nestjs/common';
import { asc, count, desc, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { type AuditContext, writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import { tracks } from '../tracks/schema.js';
import { TrackNotFoundException } from '../tracks/tracks.exceptions.js';
import {
  CohortConflictException,
  CohortNotFoundException,
} from './cohorts.exceptions.js';
import type {
  CohortDetailResponseDto,
  CohortTrackResponseDto,
} from './dto/cohort-response.dto.js';
import type { CreateCohortDto } from './dto/create-cohort.dto.js';
import { cohorts, cohortTracks, type Cohort } from './schema.js';

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
