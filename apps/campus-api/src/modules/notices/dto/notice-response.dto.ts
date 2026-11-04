import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { NoticeScope } from '../schema.js';

/** A notice as the wall shows it. The author is an id, as elsewhere. */
export class NoticeResponseDto {
  /** @example 44444444-4444-4444-8444-444444444444 */
  id: string;

  /** @example 99999999-9999-4999-8999-999999999999 */
  authorId: string;

  @ApiProperty({ enum: NoticeScope, enumName: 'NoticeScope' })
  scope: NoticeScope;

  /** Null for a campus notice. */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '11111111-1111-4111-8111-111111111111',
  })
  cohortId: string | null;

  /** Set only for a cohort-track notice. */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '22222222-2222-4222-8222-222222222222',
  })
  cohortTrackId: string | null;

  /** @example 'Campus closed Friday' */
  title: string;

  /** @example 'The campus will be closed for maintenance.' */
  body: string;

  /** @example false */
  pinned: boolean;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-09-22T12:00:00.000Z */
  updatedAt: Date;
}
