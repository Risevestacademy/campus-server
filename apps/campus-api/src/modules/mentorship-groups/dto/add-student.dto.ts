import { IsUUID } from 'class-validator';

export class AddStudentDto {
  /**
   * The cohort membership of the student. Must be a live student of this
   * cohort.
   * @example 99999999-9999-4999-8999-999999999999
   */
  @IsUUID()
  cohortMemberId: string;
}
