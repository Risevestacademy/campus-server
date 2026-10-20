import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ChangeMentorDto {
  @ApiProperty({
    example: '77777777-7777-4777-8777-777777777777',
    description:
      'The cohort membership of the new mentor. Must be a live mentor of this cohort.',
  })
  @IsUUID()
  mentorMemberId: string;
}
