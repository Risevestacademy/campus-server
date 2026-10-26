import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';
import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { AudioMode, SpaceAccess, SpaceKind } from '../schema.js';

/**
 * A field that may be named in a request but never changed. Only an absent
 * field passes: `null` counts as naming it, because it would otherwise look
 * like a request to clear a setting the route does not own.
 */
function IsNotEditable(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isNotEditable',
      validator: {
        validate: (value: unknown) => value === undefined,
        defaultMessage: (args) => `${args?.property} cannot be changed`,
      },
    },
    options,
  );
}

export const MAX_SPACE_CAPACITY = 2_147_483_647;

export const MIN_AUDIO_DISTANCE = 0;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value;

/**
 * Pagination plus the one filter this list needs: the spaces waiting for an
 * admin to say what they are.
 */
export class ListSpacesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Only live spaces with no kind set: the queue of spaces waiting to ' +
      'be set up.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  needsKind: boolean = false;
}

/**
 * A partial edit of a space's behaviour. Only the fields present are written.
 *
 * The key, the map and the map's default flag are fixed: they belong to what
 * the map says a space is, not to how an admin makes it behave. They are
 * declared here so a request that names one is refused by name, never dropped
 * silently.
 */
export class UpdateSpaceDto {
  @ApiPropertyOptional({ example: 'Reading Room', maxLength: 128 })
  @IsOptionalNotNull()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({
    enum: SpaceKind,
    enumName: 'SpaceKind',
    nullable: true,
    description:
      'Null puts the space back in the queue: no kind, and nobody but ' +
      'admins may enter it.',
  })
  @IsOptional()
  @IsEnum(SpaceKind)
  kind?: SpaceKind | null;

  @ApiPropertyOptional({
    enum: SpaceAccess,
    enumName: 'SpaceAccess',
    description:
      '`normal` admits anybody in the campus; `designated` admits whoever ' +
      'the space’s list names. The default space stays normal.',
  })
  @IsOptionalNotNull()
  @IsEnum(SpaceAccess)
  access?: SpaceAccess;

  @ApiPropertyOptional({
    enum: AudioMode,
    enumName: 'AudioMode',
    description:
      '`proximity` fades voices by distance; `boundary` lets everybody in ' +
      'the space hear everybody.',
  })
  @IsOptionalNotNull()
  @IsEnum(AudioMode)
  audioMode?: AudioMode;

  @ApiPropertyOptional({
    type: Number,
    example: 25,
    nullable: true,
    minimum: 1,
    maximum: MAX_SPACE_CAPACITY,
    description:
      `Null means no limit. At least 1 and at most ${MAX_SPACE_CAPACITY} ` +
      'when set.',
  })
  @IsOptional()
  @IsInt()
  @Max(MAX_SPACE_CAPACITY)
  capacity?: number | null;

  @ApiPropertyOptional({
    type: Number,
    example: 8.5,
    nullable: true,
    minimum: MIN_AUDIO_DISTANCE,
    description:
      'How far a voice carries, in tiles. Null leaves it unset. At least ' +
      `${MIN_AUDIO_DISTANCE}. The database stores two decimal places.`,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(MIN_AUDIO_DISTANCE)
  @Max(9999.99)
  audibleRadius?: number | null;

  @ApiPropertyOptional({
    type: Number,
    example: 10,
    nullable: true,
    minimum: MIN_AUDIO_DISTANCE,
    description:
      'The radius the media server subscribes people by, in tiles. Null ' +
      `leaves it unset. At least ${MIN_AUDIO_DISTANCE}. The database stores ` +
      'two decimal places.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(MIN_AUDIO_DISTANCE)
  @Max(9999.99)
  subscribeRadius?: number | null;

  @ApiPropertyOptional({
    type: Number,
    example: 1.2,
    description:
      'How much further than subscribeRadius somebody must go before they ' +
      'are unsubscribed. Must be greater than 0. The database stores two ' +
      'decimal places.',
  })
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(99.99)
  hysteresisFactor?: number;

  @ApiPropertyOptional({
    type: String,
    description:
      'The object’s name in Tiled. Read-only: sending it is refused, ' +
      'because renaming it there makes it a different space.',
  })
  @IsNotEditable()
  key?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Read-only: a space belongs to the map that drew it.',
  })
  @IsNotEditable()
  mapId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Read-only: whether a space is its map’s default is set by the map, ' +
      'not here.',
  })
  @IsNotEditable()
  isMapDefault?: boolean;
}

/** One space, as the routes answer with it. */
export class SpaceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The map that drew this space.',
  })
  mapId: string;

  @ApiProperty({
    example: 'library',
    description: 'The object’s name in Tiled, unique on its map.',
  })
  key: string;

  @ApiProperty({ example: 'Library' })
  name: string;

  @ApiProperty({
    enum: SpaceKind,
    enumName: 'SpaceKind',
    nullable: true,
    description: 'Null when no admin has said what the space is yet.',
  })
  kind: SpaceKind | null;

  @ApiProperty({
    description:
      'Whether this is its map’s default space: the one for tiles inside ' +
      'no drawn space.',
  })
  isMapDefault: boolean;

  @ApiProperty({ enum: SpaceAccess, enumName: 'SpaceAccess' })
  access: SpaceAccess;

  @ApiProperty({ enum: AudioMode, enumName: 'AudioMode' })
  audioMode: AudioMode;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 25,
    description: 'Null means no limit.',
  })
  capacity: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '8.50',
    description: 'In tiles, or null when it is unset.',
  })
  audibleRadius: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '10.00',
    description: 'In tiles, or null when it is unset.',
  })
  subscribeRadius: string | null;

  @ApiProperty({ type: String, example: '1.20' })
  hysteresisFactor: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Set when the space is no longer on its map.',
  })
  retiredAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
