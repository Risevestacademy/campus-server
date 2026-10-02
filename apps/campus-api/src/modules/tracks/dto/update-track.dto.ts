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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A partial track edit: only the fields present are written. */
export class UpdateTrackDto {
  @ApiPropertyOptional({ example: 'Software Engineering', maxLength: 128 })
  @IsOptional()
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
  @IsOptional()
  @IsCatalogCode()
  code?: string;

  @ApiPropertyOptional({
    example: 'Backend and infra',
    description: 'An empty string clears it.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  description?: string;
}

export class TrackIdParamDto {
  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  @IsUUID()
  id: string;
}
