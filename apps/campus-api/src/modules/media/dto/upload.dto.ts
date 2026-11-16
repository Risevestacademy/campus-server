import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

import { MediaKind } from '../schema.js';

export class CreateUploadDto {
  @ApiProperty({ enum: MediaKind, enumName: 'MediaKind' })
  @IsEnum(MediaKind)
  kind: MediaKind;

  /**
   * The file's type, sent again as the PUT's `Content-Type`.
   * @example image/webp
   */
  @IsString()
  @MaxLength(128)
  contentType: string;

  /**
   * The file's exact size in bytes. The PUT must carry exactly this many.
   * @example 48213
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes: number;
}

export class UploadDto {
  /** Hand this to the endpoint that uses the file. @example 88888888-8888-4888-8888-888888888888 */
  mediaId: string;

  /**
   * Where to PUT the file: a private holding place, signed for this type and
   * size only. The file is served from elsewhere once it is checked, so a
   * second PUT here changes nothing that is served.
   */
  uploadUrl: string;

  @ApiProperty({ enum: ['PUT'] })
  method: 'PUT';

  /**
   * Send these with the PUT, exactly. The browser sets Content-Length itself.
   * @example {"Content-Type":"image/webp"}
   */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  headers: Record<string, string>;

  /** After this the URL no longer works; ask for another. */
  expiresAt: Date;
}

export class UploadKindLimitsDto {
  @ApiProperty({ enum: MediaKind, enumName: 'MediaKind' })
  kind: MediaKind;

  /** @example ["image/jpeg","image/png","image/webp"] */
  contentTypes: string[];

  /** @example 2097152 */
  maxBytes: number;
}

export class UploadLimitsDto {
  @ApiProperty({ type: [UploadKindLimitsDto] })
  kinds: UploadKindLimitsDto[];
}
