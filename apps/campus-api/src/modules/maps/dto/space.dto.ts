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

export const MIN_SPACE_CAPACITY = 1;

export const MIN_AUDIO_DISTANCE = 0;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value;

/**
 * Pagination plus the one filter this list needs: the spaces waiting for an
 * admin to say what they are.
 */
export class ListSpacesQueryDto extends PaginationQueryDto {
  /**
   * Only live spaces with no kind set: the queue of spaces waiting to be set
   * up.
   */
  @ApiPropertyOptional()
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
  /** @example "Reading Room" */
  @IsOptionalNotNull()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  /**
   * Null puts the space back in the queue: no kind, and nobody but admins may
   * enter it.
   */
  @ApiPropertyOptional({
    enum: SpaceKind,
    enumName: 'SpaceKind',
    nullable: true,
  })
  @IsOptional()
  @IsEnum(SpaceKind)
  kind?: SpaceKind | null;

  /**
   * `normal` admits anybody in the campus; `designated` admits whoever the
   * space’s list names. The default space stays normal.
   */
  @ApiPropertyOptional({ enum: SpaceAccess, enumName: 'SpaceAccess' })
  @IsOptionalNotNull()
  @IsEnum(SpaceAccess)
  access?: SpaceAccess;

  /**
   * `proximity` fades voices by distance; `boundary` lets everybody in the
   * space hear everybody.
   */
  @ApiPropertyOptional({ enum: AudioMode, enumName: 'AudioMode' })
  @IsOptionalNotNull()
  @IsEnum(AudioMode)
  audioMode?: AudioMode;

  /** @example 25 */
  @ApiPropertyOptional({
    description:
      `Null means no limit. At least ${MIN_SPACE_CAPACITY} and at most ` +
      `${MAX_SPACE_CAPACITY} when set.`,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_SPACE_CAPACITY)
  @Max(MAX_SPACE_CAPACITY)
  capacity?: number | null;

  /** @example 8.5 */
  @ApiPropertyOptional({
    description:
      'How far a voice carries, in tiles. Null leaves it unset. At least ' +
      `${MIN_AUDIO_DISTANCE}. The database stores two decimal places.`,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(MIN_AUDIO_DISTANCE)
  @Max(9999.99)
  audibleRadius?: number | null;

  /** @example 10 */
  @ApiPropertyOptional({
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

  /**
   * How much further than subscribeRadius somebody must go before they are
   * unsubscribed. Must be greater than 0. The database stores two decimal
   * places.
   * @example 1.2
   */
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(99.99)
  hysteresisFactor?: number;

  /**
   * The object’s name in Tiled. Read-only: sending it is refused, because
   * renaming it there makes it a different space.
   */
  @IsNotEditable()
  key?: string;

  /** Read-only: a space belongs to the map that drew it. */
  @IsNotEditable()
  mapId?: string;

  /**
   * Read-only: whether a space is its map’s default is set by the map, not
   * here.
   */
  @IsNotEditable()
  isMapDefault?: boolean;
}

/** One space, as the routes answer with it. */
export class SpaceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  /** The map that drew this space. */
  @ApiProperty({ format: 'uuid' })
  mapId: string;

  /**
   * The object’s name in Tiled, unique on its map.
   * @example library
   */
  key: string;

  /** @example Library */
  name: string;

  /** Null when no admin has said what the space is yet. */
  @ApiProperty({ enum: SpaceKind, enumName: 'SpaceKind', nullable: true })
  kind: SpaceKind | null;

  /**
   * Whether this is its map’s default space: the one for tiles inside no drawn
   * space.
   */
  isMapDefault: boolean;

  @ApiProperty({ enum: SpaceAccess, enumName: 'SpaceAccess' })
  access: SpaceAccess;

  @ApiProperty({ enum: AudioMode, enumName: 'AudioMode' })
  audioMode: AudioMode;

  /**
   * Null means no limit.
   * @example 25
   */
  capacity: number | null;

  /**
   * In tiles, or null when it is unset.
   * @example "8.50"
   */
  audibleRadius: string | null;

  /**
   * In tiles, or null when it is unset.
   * @example "10.00"
   */
  subscribeRadius: string | null;

  /** @example "1.20" */
  hysteresisFactor: string;

  /** Set when the space is no longer on its map. */
  retiredAt: Date | null;

  createdAt: Date;

  updatedAt: Date;
}
