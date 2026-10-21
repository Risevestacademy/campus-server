import { ApiProperty } from '@nestjs/swagger';

import { RosterUserDto } from '../../cohorts/dto/cohort-roster.dto.js';

/** The mentor of a group, named by the membership they hold. */
export class MentorshipGroupMentorDto {
  @ApiProperty({
    example: '77777777-7777-4777-8777-777777777777',
    description: 'The cohort membership, not the person.',
  })
  cohortMemberId: string;

  @ApiProperty({ type: () => RosterUserDto })
  user: RosterUserDto;
}

/** One student in a group. */
export class MentorshipGroupStudentDto {
  @ApiProperty({
    example: '99999999-9999-4999-8999-999999999999',
    description: 'The cohort membership, not the person.',
  })
  cohortMemberId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-20T12:00:00.000Z',
  })
  joinedAt: Date;

  @ApiProperty({ type: () => RosterUserDto })
  user: RosterUserDto;
}

export class MentorshipGroupResponseDto {
  @ApiProperty({ example: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  id: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ example: 'Pod A' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Mentors the backend track.',
  })
  description: string | null;

  @ApiProperty({ type: () => MentorshipGroupMentorDto })
  mentor: MentorshipGroupMentorDto;

  @ApiProperty({
    type: [MentorshipGroupStudentDto],
    description: 'Current students, by name.',
  })
  students: MentorshipGroupStudentDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-20T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-20T12:00:00.000Z',
  })
  updatedAt: Date;
}
