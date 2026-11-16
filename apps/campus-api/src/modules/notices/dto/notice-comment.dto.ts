import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { COMMENT_BODY_MAX_LENGTH } from '../../comments/schema.js';

/**
 * Characters that take up no room and say nothing: the control characters
 * other than tab and line breaks, and the zero-width ones. NUL is among
 * them, which Postgres refuses in text and would turn into a 500.
 *
 * They go before the trim, so text made only of them is seen for what it is:
 * blank. `trim()` on its own leaves them, and what counts as blank here has
 * to be what the database's own check counts as blank.
 */
const INVISIBLE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g;

const tidy = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(INVISIBLE, '').trim() : value;

export class CreateNoticeCommentDto {
  /** @example 'I can help with the setup on Friday.' */
  @Transform(tidy)
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body: string;
}

/** One comment under a notice. The author is an id, as elsewhere. */
export class NoticeCommentDto {
  /** @example aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa */
  id: string;

  /** @example 99999999-9999-4999-8999-999999999999 */
  @ApiProperty({ format: 'uuid' })
  authorId: string;

  /** @example 'I can help with the setup on Friday.' */
  body: string;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;
}
