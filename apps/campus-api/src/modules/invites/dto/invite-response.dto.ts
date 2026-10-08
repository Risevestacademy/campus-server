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
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  id: string;

  @ApiProperty({ example: 'new.student@campus.local' })
  email: string;

  // The four below are always sent, as null when the invite has none. The
  // type is spelt out because the generator cannot read it off `T | null`:
  // left to itself it documents a bare object, and a client generated from
  // that cannot use the value.
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Null for an invite that grants a system role only.',
  })
  cohortId: string | null;

  @ApiProperty({
    enum: CohortRole,
    enumName: 'CohortRole',
    nullable: true,
    description: 'Null for an invite that grants a system role only.',
  })
  cohortRole: CohortRole | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '22222222-2222-4222-8222-222222222222',
    description:
      'The cohort’s own link to a track, not the catalogue track. Null ' +
      'when the invite places nobody on a track.',
  })
  cohortTrackId: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '33333333-3333-4333-8333-333333333333',
    description: 'Null when the invite assigns no mentorship group.',
  })
  mentorshipGroupId: string | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({ enum: InviteStatus, enumName: 'InviteStatus' })
  status: InviteStatus;

  @ApiProperty({ example: '2026-09-29T12:00:00.000Z' })
  expiresAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-05T17:00:00.000Z',
    description:
      'Guest invites only; null otherwise. When the visit itself ends, which ' +
      'is not expiresAt above — that is how long the link stays redeemable, ' +
      'and it is clamped to never outlast this.',
  })
  guestAccessExpiresAt: string | null;

  @ApiProperty({
    example: 'http://localhost:3000/invitation?token=abc123',
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

  @ApiProperty({
    enum: InviteEmailStatus,
    enumName: 'InviteEmailStatus',
    example: InviteEmailStatus.Sent,
    description:
      '`sent`: Resend accepted the email. `failed`: it was not confirmed ' +
      'sent — share inviteLink by hand; the invite exists either way. ' +
      '`disabled`: this deployment sends no email (FF_EMAIL_ENABLED off).',
  })
  emailStatus: InviteEmailStatus;
}
