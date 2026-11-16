import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { InviteEmailStatus } from './invite-response.dto.js';

export class ImportInvitesDto {
  /**
   * The cohort every row in the file is invited to.
   * @example 11111111-1111-4111-8111-111111111111
   */
  @IsUUID()
  cohortId: string;
}

export enum InviteImportOutcome {
  Invited = 'invited',
  Failed = 'failed',
}

/** What happened to one row of the file. */
export class InviteImportRowDto {
  /**
   * The line in the file, counting the header as line 1, as a spreadsheet
   * numbers it.
   * @example 2
   */
  line: number;

  /**
   * The address as the file gave it, lowercased.
   * @example ada@campus.local
   */
  email: string;

  @ApiProperty({ enum: InviteImportOutcome, enumName: 'InviteImportOutcome' })
  outcome: InviteImportOutcome;

  /**
   * Invited rows only.
   * @example 44444444-4444-4444-8444-444444444444
   */
  inviteId?: string;

  /**
   * Invited rows only. Shown once, as it is when one invite is created: share
   * it by hand if `emailStatus` is not `sent`.
   * @example https://campus.example/invitation?token=…
   */
  inviteLink?: string;

  /** Invited rows only: whether the invite email went out. */
  @ApiPropertyOptional({
    enum: InviteEmailStatus,
    enumName: 'InviteEmailStatus',
  })
  emailStatus?: InviteEmailStatus;

  /**
   * Failed rows only: why, in words for the admin.
   * @example "A pending invite already exists for ada@campus.local"
   */
  reason?: string;
}

export class InviteImportResponseDto {
  /**
   * Rows in the file, header aside.
   * @example 3
   */
  total: number;

  /** @example 2 */
  invited: number;

  /** @example 1 */
  failed: number;

  /** One entry per row, in the order of the file. */
  rows: InviteImportRowDto[];
}
