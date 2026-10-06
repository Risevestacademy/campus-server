import { ApiProperty } from '@nestjs/swagger';

import { TrackResponseDto } from '../../tracks/dto/track-response.dto.js';
import { CohortRole, CohortStatus } from '../schema.js';

export class CohortResponseDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  id: string;

  @ApiProperty({ example: 'Cohort 1' })
  name: string;

  @ApiProperty({ example: 'C1' })
  code: string;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-09-01',
    nullable: true,
  })
  startDate: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2027-06-30',
    nullable: true,
  })
  endDate: string | null;

  @ApiProperty({ enum: CohortStatus, enumName: 'CohortStatus' })
  status: CohortStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  updatedAt: Date;
}

/**
 * A track as one cohort runs it. `id` is the COHORT_TRACKS row — the
 * cohortTrackId a student invite names — and `track` is the catalogue entry
 * behind it.
 */
export class CohortTrackResponseDto {
  @ApiProperty({
    example: '22222222-2222-4222-8222-222222222222',
    description: 'The cohortTrackId to put on a student invite.',
  })
  id: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ type: TrackResponseDto })
  track: TrackResponseDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;
}

export class CohortDetailResponseDto extends CohortResponseDto {
  @ApiProperty({
    type: [CohortTrackResponseDto],
    description: 'The tracks this cohort runs, by track name.',
  })
  tracks: CohortTrackResponseDto[];
}

/**
 * A membership with the fields that identify it and the deadline it runs to:
 * what a guest's visit looks like to the admin who just moved it.
 */
export class CohortMemberResponseDto {
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
    type: String,
    format: 'date-time',
    example: '2026-10-20T12:00:00.000Z',
    description: 'When the visit now ends.',
  })
  accessExpiresAt: Date;
}
