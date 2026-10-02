import { Inject, Injectable } from '@nestjs/common';
import { asc, count, desc, eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isForeignKeyViolation } from '../../infra/database/foreign-key-violation.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
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

/**
 * Creating cohorts and choosing which tracks each one runs — the setup an
 * invite needs before it can name a cohort and a cohortTrackId. Membership
 * lives in CohortMembersService, which the session layer depends on; this
 * one is admin tooling and nothing else imports it.
 */
@Injectable()
export class CohortsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(dto: CreateCohortDto): Promise<Cohort> {
    try {
      const [row] = await this.db
        .insert(cohorts)
        .values({
          name: dto.name,
          code: dto.code,
          startDate: dto.startDate ?? null,
          endDate: dto.endDate ?? null,
          status: dto.status,
        })
        .returning();
      return row;
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
      const [link] = await this.db
        .insert(cohortTracks)
        .values({ cohortId, trackId })
        .returning();
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

  async update(id: string, dto: UpdateCohortDto): Promise<Cohort> {
    const existing = await this.findCohort(id);

    // The DTO checks each date on its own; only the merged pair can say
    // whether a one-sided change inverts the range.
    const startDate =
      dto.startDate === undefined
        ? existing.startDate
        : (dto.startDate ?? null);
    const endDate =
      dto.endDate === undefined ? existing.endDate : (dto.endDate ?? null);
    if (startDate !== null && endDate !== null && endDate < startDate) {
      throw new CohortInvalidArgumentException('Request validation failed', {
        fields: { endDate: 'endDate must be on or after startDate' },
      });
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

    try {
      const [row] = await this.db
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
      if (!row) {
        throw new CohortNotFoundException(`Cohort ${id} not found`, {
          cohortId: id,
        });
      }
      return row;
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

  async remove(id: string): Promise<void> {
    try {
      const [row] = await this.db
        .delete(cohorts)
        .where(eq(cohorts.id, id))
        .returning({ id: cohorts.id });
      if (!row) {
        throw new CohortNotFoundException(`Cohort ${id} not found`, {
          cohortId: id,
        });
      }
    } catch (err) {
      // The FKs are restrictive on purpose: a cohort with tracks, members
      // or invites is refused rather than emptied, and there is no detach
      // route yet, so the message says what has to go first.
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
