import { IsUUID } from 'class-validator';

export class MentorshipGroupCohortParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;
}

export class MentorshipGroupParamDto extends MentorshipGroupCohortParamDto {
  /** @example aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa */
  @IsUUID()
  groupId: string;
}

export class MentorshipGroupStudentParamDto extends MentorshipGroupParamDto {
  /**
   * The cohort membership, not the user.
   * @example 99999999-9999-4999-8999-999999999999
   */
  @IsUUID()
  cohortMemberId: string;
}
