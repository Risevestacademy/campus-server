import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { IsCatalogCode } from '../../../shared/dto/catalog-code.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTrackDto {
  @ApiProperty({ example: 'Software Engineering', maxLength: 128 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiProperty({
    example: 'SE',
    maxLength: 32,
    description: 'Unique across tracks. Stored uppercase.',
  })
  @IsCatalogCode()
  code: string;

  @ApiPropertyOptional({ example: 'Backend and infra' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  description?: string;
}
