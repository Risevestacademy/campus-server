import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';
import { InviteStatus } from '../schema.js';

export class InviteResponseDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  id: string;

  @ApiProperty({ example: 'new.student@campus.local' })
  email: string;

  @ApiPropertyOptional({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string | null;

  @ApiPropertyOptional({ enum: CohortRole, enumName: 'CohortRole' })
  cohortRole: CohortRole | null;

  @ApiPropertyOptional({ example: '22222222-2222-4222-8222-222222222222' })
  cohortTrackId: string | null;

  @ApiPropertyOptional({ example: '33333333-3333-4333-8333-333333333333' })
  mentorshipGroupId: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: InviteStatus, enumName: 'InviteStatus' })
  status: InviteStatus;

  @ApiProperty({ example: '2026-09-29T12:00:00.000Z' })
  expiresAt: string;

  @ApiProperty({
    example: 'http://localhost:3000/invite?token=abc123',
    description:
      'Shareable link embedding the RAW unhashed token. Shown exactly once — ' +
      'only the SHA-256 hash is stored in INVITES.token_hash.',
  })
  inviteLink: string;

  /**
   * The raw token itself, returned once alongside inviteLink so API clients
   * (and Postman) can build their own link. Never persisted server-side.
   */
  @ApiProperty({
    example: 'abc123',
    description: 'Raw token. Never stored; only its hash lives in the DB.',
  })
  token: string;

  @ApiProperty({ example: '2026-09-22T12:00:00.000Z' })
  createdAt: string;
}
