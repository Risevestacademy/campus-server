import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import {
  FEEDBACK_ABOUT_MAX_LENGTH,
  FEEDBACK_DETAILS_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  FeedbackStatus,
  FeedbackType,
} from '../schema.js';

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

/** The same, with nothing left counting as not sent at all. */
const tidyOptional = (params: { value: unknown }): unknown => {
  const value = tidy(params);
  return value === '' ? undefined : value;
};

/** Where the member was, as their client reports it. All of it optional. */
export class FeedbackContextDto {
  @ApiPropertyOptional({
    example: '/campus',
    maxLength: 300,
    description: 'The page or screen they were on.',
  })
  @IsOptional()
  @Transform(tidyOptional)
  @IsString()
  @MaxLength(300)
  path?: string;

  @ApiPropertyOptional({
    example: 'campus',
    maxLength: 64,
    description: 'The map they were on, from `snapshot.map.id`.',
  })
  @IsOptional()
  @Transform(tidyOptional)
  @IsString()
  @MaxLength(64)
  mapId?: string;

  @ApiPropertyOptional({
    example: 'd686dbad05445e71',
    maxLength: 64,
    description: 'That map’s version, from `snapshot.map.version`.',
  })
  @IsOptional()
  @Transform(tidyOptional)
  @IsString()
  @MaxLength(64)
  mapVersion?: string;

  @ApiPropertyOptional({ example: 75, description: 'The tile they stood on.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  x?: number;

  @ApiPropertyOptional({ example: 59 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  y?: number;
}

export class CreateFeedbackDto {
  @ApiProperty({ enum: FeedbackType, enumName: 'FeedbackType' })
  @IsEnum(FeedbackType)
  type: FeedbackType;

  @ApiProperty({
    example: 'The library door will not open',
    maxLength: FEEDBACK_TITLE_MAX_LENGTH,
  })
  @Transform(tidy)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_TITLE_MAX_LENGTH)
  title: string;

  @ApiProperty({
    example: 'I walk up to it from the courtyard and nothing happens.',
    maxLength: FEEDBACK_DETAILS_MAX_LENGTH,
  })
  @Transform(tidy)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_DETAILS_MAX_LENGTH)
  details: string;

  @ApiPropertyOptional({
    example: 'The library, by the east door',
    maxLength: FEEDBACK_ABOUT_MAX_LENGTH,
    description:
      'Who or where, in the member’s own words: who a report is about, ' +
      'where a bug happened. Offered on every type and required on none. ' +
      'Blank is taken as not given.',
  })
  @IsOptional()
  @Transform(tidyOptional)
  @IsString()
  @MaxLength(FEEDBACK_ABOUT_MAX_LENGTH)
  about?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description:
      'The account a report is about, when the member picked a person ' +
      'rather than typing a name. Only on a `report`. That person is not ' +
      'told.',
  })
  @IsOptional()
  @IsUUID()
  reportedUserId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description: 'The cohort they were in when they sent it.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiPropertyOptional({
    type: () => FeedbackContextDto,
    description:
      'Where they were, filled in by the client rather than typed. A hint ' +
      'for whoever reads a bug.',
  })
  @IsOptional()
  // One object. Without this a list of them passes, each checked on its own,
  // and is saved as something no reader expects.
  @IsObject()
  @ValidateNested()
  @Type(() => FeedbackContextDto)
  context?: FeedbackContextDto;
}

/** What the member gets back: that it arrived, and nothing to act on. */
export class FeedbackReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: FeedbackType, enumName: 'FeedbackType' })
  type: FeedbackType;

  @ApiProperty({ example: 'The library door will not open' })
  title: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-12T09:30:00.000Z',
  })
  createdAt: Date;
}

/** Pagination plus the filters, every one optional and combined with AND. */
export class ListFeedbackQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FeedbackType, enumName: 'FeedbackType' })
  @IsOptional()
  @IsEnum(FeedbackType)
  type?: FeedbackType;

  @ApiPropertyOptional({ enum: FeedbackStatus, enumName: 'FeedbackStatus' })
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Everything this account has sent.',
  })
  @IsOptional()
  @IsUUID()
  submittedBy?: string;
}

/** Somebody named on a piece of feedback, as an admin needs to see them. */
export class FeedbackPersonDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ada@campus.local' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ada Lovelace' })
  displayName: string | null;
}

/** One row of the admin's list. The details are on the single read. */
export class FeedbackListItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: FeedbackType, enumName: 'FeedbackType' })
  type: FeedbackType;

  @ApiProperty({ example: 'The library door will not open' })
  title: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'The library, by the east door',
    description: 'Who or where, as the member put it. Null when not given.',
  })
  about: string | null;

  @ApiProperty({ enum: FeedbackStatus, enumName: 'FeedbackStatus' })
  status: FeedbackStatus;

  @ApiProperty({ type: () => FeedbackPersonDto })
  submittedBy: FeedbackPersonDto;

  @ApiProperty({
    type: () => FeedbackPersonDto,
    nullable: true,
    description: 'The account a report names, if it names one.',
  })
  reportedUser: FeedbackPersonDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-12T09:30:00.000Z',
  })
  createdAt: Date;
}

/** One piece of feedback, whole. */
export class FeedbackDto extends FeedbackListItemDto {
  @ApiProperty({
    example: 'I walk up to it from the courtyard and nothing happens.',
  })
  details: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The cohort they were in, if their client said.',
  })
  cohortId: string | null;

  @ApiProperty({
    type: () => FeedbackContextDto,
    nullable: true,
    description:
      'Where the member’s client said they were. Not checked against ' +
      'anything.',
  })
  context: FeedbackContextDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Mozilla/5.0 (Macintosh; …) Chrome/141.0',
    description: 'The browser or app that sent it.',
  })
  userAgent: string | null;

  @ApiProperty({
    type: () => FeedbackPersonDto,
    nullable: true,
    description: 'The admin who marked it resolved. Null while it is open.',
  })
  resolvedBy: FeedbackPersonDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-13T11:00:00.000Z',
  })
  resolvedAt: Date | null;
}

export class UpdateFeedbackStatusDto {
  @ApiProperty({ enum: FeedbackStatus, enumName: 'FeedbackStatus' })
  @IsEnum(FeedbackStatus)
  status: FeedbackStatus;
}

export class FeedbackIdParamDto {
  @ApiProperty({
    format: 'uuid',
    example: '66666666-6666-4666-8666-666666666666',
  })
  @IsUUID()
  id: string;
}
