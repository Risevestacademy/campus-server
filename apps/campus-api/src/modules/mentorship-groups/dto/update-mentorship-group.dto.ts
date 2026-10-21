import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';
import { MENTORSHIP_GROUP_NAME_MAX_LENGTH } from './create-mentorship-group.dto.js';

/** A partial edit of the name or description. */
export class UpdateMentorshipGroupDto {
  @ApiPropertyOptional({
    example: 'Pod A',
    maxLength: MENTORSHIP_GROUP_NAME_MAX_LENGTH,
    description: 'Unique within the cohort, whatever its case.',
  })
  @IsOptionalNotNull()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MENTORSHIP_GROUP_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    example: 'Mentors the backend track.',
    type: String,
    nullable: true,
    description: 'null clears it.',
  })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.replaceAll('\u0000', '').trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  description?: string | null;
}
