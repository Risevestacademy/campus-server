import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';

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
import type { CreateTrackDto } from './dto/create-track.dto.js';
import type { UpdateTrackDto } from './dto/update-track.dto.js';
import { tracks, type Track } from './schema.js';
import {
  TrackConflictException,
  TrackNotFoundException,
} from './tracks.exceptions.js';

/** What an admin can edit on a track, and so what an update entry compares. */
const TRACK_AUDITED_FIELDS = ['name', 'code', 'description'] as const;

@Injectable()
export class TracksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(dto: CreateTrackDto, audit: AuditContext): Promise<Track> {
    try {
      // One transaction, so a track is never created without its entry.
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(tracks)
          .values({
            name: dto.name,
            code: dto.code,
            description: dto.description || null,
          })
          .returning();
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.TrackCreated,
          subject: { type: AuditSubjectType.Track, id: row.id },
          details: { name: row.name, code: row.code },
        });
        return row;
      });
    } catch (err) {
      // Left to the unique index rather than checked first: a check-then-
      // insert still loses to a concurrent create, and would answer 500.
      if (isUniqueViolation(err, 'tracks_code_unique')) {
        throw new TrackConflictException(
          `A track with code ${dto.code} already exists`,
          { code: dto.code },
        );
      }
      throw err;
    }
  }

  async list(query: PaginationQueryDto): Promise<PaginatedResponseDto<Track>> {
    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(tracks)
        // id breaks ties, so a page boundary never lands between two rows
        // whose order the database is free to swap.
        .orderBy(asc(tracks.name), asc(tracks.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(tracks),
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

  async update(
    id: string,
    dto: UpdateTrackDto,
    audit: AuditContext,
  ): Promise<Track> {
    try {
      return await this.db.transaction(async (tx) => {
        // Locked, so the `from` side of the entry is the row this write
        // replaced, not one a concurrent edit had already moved on from.
        const [existing] = await tx
          .select()
          .from(tracks)
          .where(eq(tracks.id, id))
          .for('update');
        if (!existing) {
          throw new TrackNotFoundException(`Track ${id} not found`, {
            trackId: id,
          });
        }

        if (
          dto.name === undefined &&
          dto.code === undefined &&
          dto.description === undefined
        ) {
          return existing;
        }

        const [row] = await tx
          .update(tracks)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            // Absent keeps the text; an empty string clears it, like create.
            ...(dto.description !== undefined
              ? { description: dto.description || null }
              : {}),
          })
          .where(eq(tracks.id, id))
          .returning();

        const changes = changedFields(existing, row, TRACK_AUDITED_FIELDS);
        if (Object.keys(changes).length > 0) {
          await writeAuditEntry(tx, {
            ...audit,
            action: AuditAction.TrackUpdated,
            subject: { type: AuditSubjectType.Track, id },
            details: { changes },
          });
        }
        return row;
      });
    } catch (err) {
      // Left to the unique index rather than checked first: a check-then-
      // insert still loses to a concurrent create, and would answer 500.
      if (isUniqueViolation(err, 'tracks_code_unique')) {
        throw new TrackConflictException(
          `A track with code ${dto.code} already exists`,
          { code: dto.code },
        );
      }
      throw err;
    }
  }

  async remove(id: string, audit: AuditContext): Promise<void> {
    try {
      // One transaction, so a track is never deleted without its entry, and
      // a delete the FK refuses leaves no entry behind.
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(tracks)
          .where(eq(tracks.id, id))
          .returning();
        if (!row) {
          throw new TrackNotFoundException(`Track ${id} not found`, {
            trackId: id,
          });
        }
        await writeAuditEntry(tx, {
          ...audit,
          action: AuditAction.TrackDeleted,
          subject: { type: AuditSubjectType.Track, id },
          details: {
            name: row.name,
            code: row.code,
            description: row.description,
          },
        });
      });
    } catch (err) {
      // The cohort_tracks FK is restrictive on purpose: a track a cohort
      // runs is refused rather than detached, so the message names the hold.
      if (isForeignKeyViolation(err)) {
        throw new TrackConflictException(
          'Track cannot be deleted while it is still attached to cohorts',
          { trackId: id },
        );
      }
      throw err;
    }
  }
}
