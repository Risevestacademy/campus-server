import { Inject, Injectable } from '@nestjs/common';
import { asc, count } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { type AuditContext, writeAuditEntry } from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import type { CreateTrackDto } from './dto/create-track.dto.js';
import { tracks, type Track } from './schema.js';
import { TrackConflictException } from './tracks.exceptions.js';

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
}
