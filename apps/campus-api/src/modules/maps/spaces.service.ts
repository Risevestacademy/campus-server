import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import { isCheckViolation } from '../../infra/database/check-violation.js';
import { isUniqueViolation } from '../../infra/database/unique-violation.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import {
  type AuditContext,
  changedFields,
  writeAuditEntry,
} from '../audit/audit-log.js';
import { AuditAction, AuditSubjectType } from '../audit/schema.js';
import type { ListSpacesQueryDto, UpdateSpaceDto } from './dto/space.dto.js';
import {
  SpaceConflictException,
  SpaceInvalidArgumentException,
  SpaceNotFoundException,
} from './maps.exceptions.js';
import { SpaceKind, spaces, type Space } from './schema.js';
import { tellWorld } from './tell-world.js';

/** What an admin can edit on a space, and so what an update entry compares. */
const SPACE_AUDITED_FIELDS = [
  'name',
  'kind',
  'access',
  'audioMode',
  'capacity',
  'audibleRadius',
  'subscribeRadius',
  'hysteresisFactor',
] as const;

/**
 * The admin side of what a space is and how it behaves. The map says which
 * spaces exist; this decides what each one is for: its kind, who may enter,
 * how audio works and how many fit. The geometry stays with the map.
 */
@Injectable()
export class SpacesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Every live space, by name. `needsKind` narrows it to the ones with no
   * kind: the queue of spaces the map drew and no admin has set up yet.
   */
  async list(query: ListSpacesQueryDto): Promise<PaginatedResponseDto<Space>> {
    const filter = and(
      isNull(spaces.retiredAt),
      query.needsKind ? isNull(spaces.kind) : undefined,
    );

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(spaces)
        .where(filter)
        .orderBy(asc(spaces.name), asc(spaces.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      this.db.select({ total: count() }).from(spaces).where(filter),
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

  async get(id: string): Promise<Space> {
    const [space] = await this.db
      .select()
      .from(spaces)
      .where(eq(spaces.id, id))
      .limit(1);
    if (!space) {
      throw new SpaceNotFoundException(`Space ${id} not found`, {
        spaceId: id,
      });
    }
    return space;
  }

  /**
   * A partial edit: only the fields present are written. The row is locked
   * first, so the before-image the entry records is the one the update
   * actually replaced.
   *
   * The database is the source of truth for the combinations a space may not
   * be: its checks and partial unique indexes refuse them, and each refusal
   * is turned into the answer that names the rule. The entry is written in
   * the same transaction, so a refused update leaves neither a changed row
   * nor an entry.
   */
  async update(
    id: string,
    dto: UpdateSpaceDto,
    audit: AuditContext,
  ): Promise<Space> {
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(spaces)
          .where(eq(spaces.id, id))
          .for('update');
        if (!existing) {
          throw new SpaceNotFoundException(`Space ${id} not found`, {
            spaceId: id,
          });
        }

        if (
          dto.name === undefined &&
          dto.kind === undefined &&
          dto.access === undefined &&
          dto.audioMode === undefined &&
          dto.capacity === undefined &&
          dto.audibleRadius === undefined &&
          dto.subscribeRadius === undefined &&
          dto.hysteresisFactor === undefined
        ) {
          return existing;
        }

        const [row] = await tx
          .update(spaces)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.access !== undefined ? { access: dto.access } : {}),
            ...(dto.audioMode !== undefined
              ? { audioMode: dto.audioMode }
              : {}),
            ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
            ...(dto.audibleRadius !== undefined
              ? {
                  audibleRadius:
                    dto.audibleRadius === null
                      ? null
                      : dto.audibleRadius.toFixed(2),
                }
              : {}),
            ...(dto.subscribeRadius !== undefined
              ? {
                  subscribeRadius:
                    dto.subscribeRadius === null
                      ? null
                      : dto.subscribeRadius.toFixed(2),
                }
              : {}),
            ...(dto.hysteresisFactor !== undefined
              ? { hysteresisFactor: dto.hysteresisFactor.toFixed(2) }
              : {}),
          })
          .where(eq(spaces.id, id))
          .returning();

        const changes = changedFields(existing, row, SPACE_AUDITED_FIELDS);
        if (Object.keys(changes).length > 0) {
          await writeAuditEntry(tx, {
            ...audit,
            spaceId: id,
            action: AuditAction.SpaceUpdated,
            subject: { type: AuditSubjectType.Space, id },
            details: { changes },
          });
          // A space's door or its audio room changed, so world reads its
          // spaces again once this commits.
          await tellWorld(tx);
        }
        return row;
      });
    } catch (err) {
      throw this.translateWriteError(err, id);
    }
  }

  /**
   * Turns the named constraints an edit can trip into the answers a client
   * can act on. Anything else is a genuine failure and is rethrown.
   */
  private translateWriteError(err: unknown, id: string): unknown {
    if (isCheckViolation(err, 'spaces_default_is_normal')) {
      const message = 'The default space must be open to everybody';
      return new SpaceInvalidArgumentException(message, {
        spaceId: id,
        fields: { access: message },
      });
    }
    if (isCheckViolation(err, 'spaces_capacity_positive')) {
      const message = 'Capacity must be at least 1';
      return new SpaceInvalidArgumentException(message, {
        spaceId: id,
        fields: { capacity: message },
      });
    }
    if (isUniqueViolation(err, 'spaces_single_town_hall')) {
      return new SpaceConflictException('The campus already has a town hall', {
        spaceId: id,
        kind: SpaceKind.TownHall,
      });
    }
    if (isUniqueViolation(err, 'spaces_single_notice_board')) {
      return new SpaceConflictException(
        'The campus already has a notice board',
        { spaceId: id, kind: SpaceKind.NoticeBoard },
      );
    }
    return err;
  }
}
