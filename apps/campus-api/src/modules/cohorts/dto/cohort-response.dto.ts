import { ApiProperty } from '@nestjs/swagger';

import { TrackResponseDto } from '../../tracks/dto/track-response.dto.js';
import { CohortRole, CohortStatus } from '../schema.js';

export class CohortResponseDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  id: string;

  /** @example "Cohort 1" */
  name: string;

  /** @example C1 */
  code: string;

  /** @example 2026-09-01 */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  startDate: string | null;

  /** @example 2027-06-30 */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  endDate: string | null;

  @ApiProperty({ enum: CohortStatus, enumName: 'CohortStatus' })
  status: CohortStatus;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;

  /** @example 2026-09-22T12:00:00.000Z */
  updatedAt: Date;
}

/**
 * A track as one cohort runs it. `id` is the COHORT_TRACKS row — the
 * cohortTrackId a student invite names — and `track` is the catalogue entry
 * behind it.
 */
export class CohortTrackResponseDto {
  /**
   * The cohortTrackId to put on a student invite.
   * @example 22222222-2222-4222-8222-222222222222
   */
  id: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  track: TrackResponseDto;

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: Date;
}

export class CohortDetailResponseDto extends CohortResponseDto {
  /** The tracks this cohort runs, by track name. */
  tracks: CohortTrackResponseDto[];
}

/**
 * A membership with the fields that identify it and the deadline it runs to:
 * what a guest's visit looks like to the admin who just moved it.
 */
export class CohortMemberResponseDto {
  /**
   * The membership's own id.
   * @example 55555555-5555-4555-8555-555555555555
   */
  id: string;

  /** @example 11111111-1111-4111-8111-111111111111 */
  cohortId: string;

  /** @example 44444444-4444-4444-8444-444444444444 */
  userId: string;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  /**
   * When the visit now ends.
   * @example 2026-10-20T12:00:00.000Z
   */
  accessExpiresAt: Date;
}
