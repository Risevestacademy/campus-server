import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { NoticeScope } from '../schema.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateNoticeDto {
  @ApiProperty({ example: 'Campus closed Friday', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'The campus will be closed for maintenance.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiProperty({ enum: NoticeScope, example: NoticeScope.Campus })
  @IsEnum(NoticeScope)
  scope: NoticeScope;

  @ApiPropertyOptional({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Required for cohort and cohort-track scope.',
  })
  @ValidateIf((o) => o.scope !== NoticeScope.Campus)
  @IsUUID()
  @IsOptional()
  cohortId?: string;

  @ApiPropertyOptional({
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Required for cohort-track scope.',
  })
  @ValidateIf((o) => o.scope === NoticeScope.CohortTrack)
  @IsUUID()
  @IsOptional()
  cohortTrackId?: string;
}
