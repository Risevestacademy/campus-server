import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { IsCatalogCode } from '../../../shared/dto/catalog-code.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTrackDto {
  /** @example "Software Engineering" */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  /**
   * Unique across tracks. Stored uppercase.
   * @example SE
   */
  @ApiProperty({ maxLength: 32 })
  @IsCatalogCode()
  code: string;

  /** @example "Backend and infra" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  description?: string;
}
