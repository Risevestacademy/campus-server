import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { FILE_NAME_MAX_LENGTH } from '../media-rules.js';
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

  /**
   * The file's name, shown with an attachment and used when it is
   * downloaded. Ignored for a profile picture.
   * @example timetable.pdf
   */
  @IsOptional()
  @IsString()
  @MaxLength(FILE_NAME_MAX_LENGTH)
  fileName?: string;
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

  /** The most files one notice or piece of feedback may carry. @example 10 */
  maxAttachments: number;
}

/** A private file, as a notice or a piece of feedback carries it. */
export class AttachmentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  /** @example timetable.pdf */
  @ApiProperty({ type: String, nullable: true })
  fileName: string | null;

  /** @example application/pdf */
  contentType: string;

  /** @example 48213 */
  sizeBytes: number;

  /**
   * Where to read it. Images open in the browser; anything else downloads.
   * Ask `GET /v1/media/{id}/url` for another once it expires.
   */
  url: string;

  urlExpiresAt: Date;
}

export class MediaIdParamDto {
  /** @example 88888888-8888-4888-8888-888888888888 */
  @IsUUID()
  id: string;
}

export class SignedReadDto {
  /** Where to read the file, until `expiresAt`. */
  url: string;

  expiresAt: Date;
}
