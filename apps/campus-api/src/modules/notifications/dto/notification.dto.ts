import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { NotificationKind, NotificationReferenceType } from '../schema.js';

export class EntryRequestContextDto {
  @ApiProperty({ format: 'uuid' })
  cohortId: string;

  /** @example lounge */
  spaceKey: string;
}

/**
 * One alert, without what it points at: the client fetches the notice, or
 * whatever else, itself when it needs more than a badge.
 */
export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  /**
   * What happened. More kinds will be added; show a plain alert for one you
   * do not know rather than dropping it.
   */
  @ApiProperty({
    enum: NotificationKind,
    enumName: 'NotificationKind',
    example: NotificationKind.NoticePosted,
  })
  kind: string;

  /** What `referenceId` names. Grows with `kind`. */
  @ApiProperty({
    enum: NotificationReferenceType,
    enumName: 'NotificationReferenceType',
    example: NotificationReferenceType.Notice,
  })
  referenceType: string;

  /**
   * The notice's id, or for an entry request world's own id for it, which
   * names nothing campus-api can fetch.
   * @example 3f0e1c2a-8b4d-4e6f-9a1b-2c3d4e5f6a7b
   */
  referenceId: string;

  /**
   * For an entry request, the cohort and space it was for. Null for a
   * notice, which is fetched by `referenceId` instead.
   */
  @ApiProperty({ type: EntryRequestContextDto, nullable: true })
  context: EntryRequestContextDto | null;

  /** @example false */
  read: boolean;

  /** @example 2026-11-05T09:30:00.000Z */
  createdAt: Date;
}

export class ListNotificationsQueryDto extends PaginationQueryDto {
  /** Only the ones not yet read. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  // A query string has no booleans, only the words for them.
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  unread?: boolean;
}

export class NotificationIdParamDto {
  /** @example 3f0e1c2a-8b4d-4e6f-9a1b-2c3d4e5f6a7b */
  @IsUUID()
  id: string;
}

export class MarkAllReadResponseDto {
  /**
   * How many were unread and are read now. Zero when there were none.
   * @example 4
   */
  marked: number;
}
