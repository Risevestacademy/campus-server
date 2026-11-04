import { ApiProperty } from '@nestjs/swagger';

import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';
import { InviteStatus } from '../schema.js';

/** Whether the invite email went out. */
export enum InviteEmailStatus {
  Sent = 'sent',
  Failed = 'failed',
  Disabled = 'disabled',
}

export class InviteResponseDto {
  /** @example 44444444-4444-4444-8444-444444444444 */
  id: string;

  /** @example new.student@campus.local */
  email: string;

  // The four below are always sent, as null when the invite has none.
  @ApiProperty({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Null for an invite that grants a system role only.',
  })
  cohortId: string | null;

  /** Null for an invite that grants a system role only. */
  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole', nullable: true })
  cohortRole: CohortRole | null;

  /**
   * The cohort’s own link to a track, not the catalogue track. Null when the
   * invite places nobody on a track.
   * @example 22222222-2222-4222-8222-222222222222
   */
  @ApiProperty({ format: 'uuid' })
  cohortTrackId: string | null;

  /**
   * Null when the invite assigns no mentorship group.
   * @example 33333333-3333-4333-8333-333333333333
   */
  @ApiProperty({ format: 'uuid' })
  mentorshipGroupId: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: InviteStatus, enumName: 'InviteStatus' })
  status: InviteStatus;

  /** @example 2026-09-29T12:00:00.000Z */
  expiresAt: string;

  /**
   * Guest invites only; null otherwise. When the visit itself ends, which is
   * not expiresAt above — that is how long the link stays redeemable, and it is
   * clamped to never outlast this.
   * @example 2026-10-05T17:00:00.000Z
   */
  @ApiProperty({ format: 'date-time' })
  guestAccessExpiresAt: string | null;

  /**
   * Shareable link embedding the RAW unhashed token. Shown exactly once — only
   * the SHA-256 hash is stored in INVITES.token_hash.
   * @example http://localhost:3000/invitation?token=abc123
   */
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

  /** @example 2026-09-22T12:00:00.000Z */
  createdAt: string;

  /**
   * `sent`: Resend accepted the email. `failed`: it was not confirmed sent —
   * share inviteLink by hand; the invite exists either way. `disabled`: this
   * deployment sends no email (FF_EMAIL_ENABLED off).
   */
  @ApiProperty({
    enum: InviteEmailStatus,
    enumName: 'InviteEmailStatus',
    example: InviteEmailStatus.Sent,
  })
  emailStatus: InviteEmailStatus;
}
