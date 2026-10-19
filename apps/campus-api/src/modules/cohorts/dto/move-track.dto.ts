import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { CohortRole } from '../schema.js';
import { RosterTrackDto } from './cohort-roster.dto.js';

export class MoveMemberTrackDto {
  @ApiProperty({
    example: '33333333-3333-4333-8333-333333333333',
    description: 'A track from GET /v1/tracks that this cohort runs.',
  })
  @IsUUID()
  trackId: string;
}

/** The membership after the move, with the track it now sits on. */
export class MoveMemberTrackResponseDto {
  @ApiProperty({
    example: '55555555-5555-4555-8555-555555555555',
    description: "The membership's own id.",
  })
  id: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  userId: string;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  @ApiProperty({
    type: () => RosterTrackDto,
    description: 'The track the student is on now.',
  })
  track: RosterTrackDto;
}
