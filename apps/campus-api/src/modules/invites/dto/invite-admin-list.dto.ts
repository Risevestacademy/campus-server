import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto.js';
import { CohortRole } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';
import { InviteStatus } from '../schema.js';

/**
 * The `:id` of the routes that act on one invite, mirroring CohortIdParamDto so
 * both admin surfaces validate a param the same way.
 *
 * Validated by the DTO rather than a ParseUUIDPipe on the parameter: the
 * ValidationPipe already runs globally, so this is a declaration and shows up
 * in the OpenAPI document, whereas a pipe would refuse a bad id without the
 * contract ever mentioning it.
 */
export class InviteIdParamDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  @IsUUID()
  id: string;
}

/**
 * Pagination plus the optional filters.
 *
 * Extends PaginationQueryDto rather than repeating page/perPage: this is the
 * only list in the invites module and the shape should match cohorts and
 * tracks, so the three stay trivially interchangeable for a caller.
 */
export class ListInvitesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: InviteStatus,
    enumName: 'InviteStatus',
    description:
      'Restrict to one status. Omit for all of them. `pending` is what an ' +
      'admin wants most often — the open offers that are still redeemable — ' +
      'and `revoked` is the answer to "who killed this invite".',
  })
  @IsOptional()
  @IsEnum(InviteStatus)
  status?: InviteStatus;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true` for the invites an invitee has flagged as wrong, `false` for ' +
      'the ones nobody has. Omit for both. Combine with `status=pending` ' +
      'for the flags still worth acting on.',
  })
  @IsOptional()
  // A query string has no booleans, only the words for them.
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  flagged?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description:
      'Invites to this cohort. An admin invite names no cohort, so it never ' +
      'matches. A cohort that does not exist matches nothing: an empty ' +
      'page, not a 404.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-4333-8333-333333333333',
    description:
      'Invites placed on this track, in whichever cohort runs it: the ' +
      'catalogue track id, as the roster takes it. Add `cohortId` for one ' +
      'cohort’s intake on the track.',
  })
  @IsOptional()
  @IsUUID()
  trackId?: string;
}

/**
 * One row in the admin invite list.
 *
 * Deliberately not InviteResponseDto. That one carries the raw token and the
 * shareable link, which is correct for the single invite an admin just
 * created — the token is shown exactly once and never recoverable afterwards.
 * A list would hand out every unredeemed token in the system to any admin who
 * asks for page 1, turning the audit view into a credential dump. Nothing here
 * is a secret: ids, the address, what it offers and who touched it.
 *
 * The status flip itself is not here either — a revoked row already reads
 * revoked, and `revokedBy`/`revokedAt` say who ended it and when.
 */
export class AdminInviteListItemDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  id: string;

  @ApiProperty({ example: 'new.student@campus.local' })
  email: string;

  @ApiProperty({
    enum: InviteStatus,
    enumName: 'InviteStatus',
    description:
      'Read against expiresAt, not off the stored column: a lapsed invite ' +
      'is `expired` here even before anything has materialised the flip, so ' +
      '`pending` always means still redeemable.',
  })
  status: InviteStatus;

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

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({
    example: '2026-09-29T12:00:00.000Z',
    description: 'When the link stops being redeemable.',
  })
  expiresAt: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Who sent it. Never null — an invite always has an author.',
  })
  invitedBy: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '33333333-3333-4333-8333-333333333333',
    description:
      'Who revoked it. Null unless status is `revoked`: accepted and ' +
      'declined invites have no actor to name. Also null on the few invites ' +
      'a data migration revoked, which nobody did by hand.',
  })
  revokedBy: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-25T09:30:00.000Z',
    description: 'When it was revoked. Null unless status is `revoked`.',
  })
  revokedAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'When the invitee flagged a mistake on it. Null if they never did. A ' +
      'flag changes nothing else: the invite can still be accepted.',
  })
  flaggedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'What the invitee said is wrong. Null unless flagged.',
  })
  flagMessage: string | null;

  @ApiProperty({ example: '2026-09-22T12:00:00.000Z' })
  createdAt: string;
}

/** What a revoke route hands back: the invite, as the list would show it. */
export class RevokeInviteResponseDto extends AdminInviteListItemDto {}
