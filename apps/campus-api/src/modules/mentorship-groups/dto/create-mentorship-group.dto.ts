import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const MENTORSHIP_GROUP_NAME_MAX_LENGTH = 128;

export class CreateMentorshipGroupDto {
  /**
   * Unique within the cohort, whatever its case.
   * @example "Pod A"
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MENTORSHIP_GROUP_NAME_MAX_LENGTH)
  name: string;

  /**
   * The cohort membership of the mentor. Must be a live mentor of this cohort.
   * @example 77777777-7777-4777-8777-777777777777
   */
  @IsUUID()
  mentorMemberId: string;

  /** @example "Mentors the backend track." */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.replaceAll('\u0000', '').trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  description?: string | null;
}
