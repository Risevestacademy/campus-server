import { IsUUID } from 'class-validator';

export class ChangeMentorDto {
  /**
   * The cohort membership of the new mentor. Must be a live mentor of this
   * cohort.
   * @example 77777777-7777-4777-8777-777777777777
   */
  @IsUUID()
  mentorMemberId: string;
}
