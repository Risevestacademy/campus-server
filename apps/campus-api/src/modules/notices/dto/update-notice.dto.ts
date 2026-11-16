import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateNoticeDto {
  @ApiPropertyOptional({ example: 'Updated title', maxLength: 200 })
  @IsOptionalNotNull()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'Updated body text.' })
  @IsOptionalNotNull()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  body?: string;
}

export class NoticeIdParamDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  @IsUUID()
  id: string;
}
