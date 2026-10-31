import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { IsOptionalNotNull } from '../../../shared/dto/optional-not-null.js';
import { MENTORSHIP_GROUP_NAME_MAX_LENGTH } from './create-mentorship-group.dto.js';

/** A partial edit of the name or description. */
export class UpdateMentorshipGroupDto {
  /**
   * Unique within the cohort, whatever its case.
   * @example "Pod A"
   */
  @IsOptionalNotNull()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MENTORSHIP_GROUP_NAME_MAX_LENGTH)
  name?: string;

  /**
   * null clears it.
   * @example "Mentors the backend track."
   */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.replaceAll('\u0000', '').trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  description?: string | null;
}
