import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

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
 * Pagination plus an optional status filter.
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

  @ApiProperty({ enum: InviteStatus, enumName: 'InviteStatus' })
  status: InviteStatus;

  @ApiPropertyOptional({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string | null;

  @ApiPropertyOptional({ enum: CohortRole, enumName: 'CohortRole' })
  cohortRole: CohortRole | null;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;

  @ApiProperty({
    example: '2026-09-29T12:00:00.000Z',
    description:
      'When the link stops being redeemable. Compare against status: a ' +
      '`pending` invite past this is lapsed but not yet flipped, because the ' +
      'flip is lazy.',
  })
  expiresAt: string;

  @ApiPropertyOptional({
    example: '2026-09-22T12:00:00.000Z',
    description: 'Who sent it. Never null — an invite always has an author.',
  })
  invitedBy: string;

  @ApiPropertyOptional({
    example: '2026-09-25T09:30:00.000Z',
    description:
      'Who revoked it, and when. Both null unless status is `revoked`: ' +
      'accepted and declined invites have no actor to name.',
  })
  revokedBy: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  revokedAt: string | null;

  @ApiProperty({ example: '2026-09-22T12:00:00.000Z' })
  createdAt: string;
}

/** What a revoke route hands back: the invite, as the list would show it. */
export class RevokeInviteResponseDto extends AdminInviteListItemDto {}
