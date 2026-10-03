import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { IsCatalogCode } from '../../../shared/dto/catalog-code.js';
import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A partial track edit: only the fields present are written. Name and code
 * can be changed but not cleared, so null is refused.
 */
export class UpdateTrackDto {
  @ApiPropertyOptional({ example: 'Software Engineering', maxLength: 128 })
  @IsOptionalNotNull()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({
    example: 'SE',
    maxLength: 32,
    description: 'Unique across tracks. Stored uppercase.',
  })
  @IsOptionalNotNull()
  @IsCatalogCode()
  code?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Backend and infra',
    description: 'An empty string or null clears it.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  description?: string | null;
}

export class TrackIdParamDto {
  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  @IsUUID()
  id: string;
}
