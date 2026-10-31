import { RosterUserDto } from '../../cohorts/dto/cohort-roster.dto.js';

/** The mentor of a group, named by the membership they hold. */
export class MentorshipGroupMentorDto {
  /**
   * The cohort membership, not the person.
   * @example 77777777-7777-4777-8777-777777777777
   */
  cohortMemberId: string;

  user: RosterUserDto;
}

/** One student in a group. */
export class MentorshipGroupStudentDto {
  /**
   * The cohort membership, not the person.
   * @example 99999999-9999-4999-8999-999999999999
   */
  cohortMemberId: string;

  /** @example 2026-10-20T12:00:00.000Z */
  joinedAt: Date;

  user: RosterUserDto;
}

export class MentorshipGroupResponseDto {
  /** @example aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa */
  id: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  /** @example "Pod A" */
  name: string;

  /** @example "Mentors the backend track." */
  description: string | null;

  mentor: MentorshipGroupMentorDto;

  /** Current students, by name. */
  students: MentorshipGroupStudentDto[];

  /** @example 2026-10-20T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-10-20T12:00:00.000Z */
  updatedAt: Date;
}
