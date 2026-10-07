import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { InviteEmailStatus } from './invite-response.dto.js';

export class ImportInvitesDto {
  @ApiProperty({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'The cohort every row in the file is invited to.',
  })
  @IsUUID()
  cohortId: string;
}

export enum InviteImportOutcome {
  Invited = 'invited',
  Failed = 'failed',
}

/** What happened to one row of the file. */
export class InviteImportRowDto {
  @ApiProperty({
    example: 2,
    description:
      'The line in the file, counting the header as line 1, as a ' +
      'spreadsheet numbers it.',
  })
  line: number;

  @ApiProperty({
    example: 'ada@campus.local',
    description: 'The address as the file gave it, lowercased.',
  })
  email: string;

  @ApiProperty({ enum: InviteImportOutcome, enumName: 'InviteImportOutcome' })
  outcome: InviteImportOutcome;

  @ApiPropertyOptional({
    example: '44444444-4444-4444-8444-444444444444',
    description: 'Invited rows only.',
  })
  inviteId?: string;

  @ApiPropertyOptional({
    example: 'https://campus.example/invitation?token=…',
    description:
      'Invited rows only. Shown once, as it is when one invite is created: ' +
      'share it by hand if `emailStatus` is not `sent`.',
  })
  inviteLink?: string;

  @ApiPropertyOptional({
    enum: InviteEmailStatus,
    enumName: 'InviteEmailStatus',
    description: 'Invited rows only: whether the invite email went out.',
  })
  emailStatus?: InviteEmailStatus;

  @ApiPropertyOptional({
    example: 'A pending invite already exists for ada@campus.local',
    description: 'Failed rows only: why, in words for the admin.',
  })
  reason?: string;
}

export class InviteImportResponseDto {
  @ApiProperty({ example: 3, description: 'Rows in the file, header aside.' })
  total: number;

  @ApiProperty({ example: 2 })
  invited: number;

  @ApiProperty({ example: 1 })
  failed: number;

  @ApiProperty({
    type: () => [InviteImportRowDto],
    description: 'One entry per row, in the order of the file.',
  })
  rows: InviteImportRowDto[];
}
