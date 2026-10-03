import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { SessionTokensDto } from '../../auth/dto/session-tokens.dto.js';
import { CohortRole, StudentStatus } from '../../cohorts/schema.js';
import { SystemRole } from '../../users/schema.js';
import { InviteStatus } from '../schema.js';

/**
 * The two answers an invitee can give. Named for the caller rather than the
 * state it produces, so a future third outcome does not force a rename.
 */
export enum InviteDecision {
  Accept = 'accept',
  Decline = 'decline',
}

export class InviteDecisionDto {
  @ApiProperty({
    enum: InviteDecision,
    enumName: 'InviteDecision',
    description:
      'Accept admits the invitee: cohort membership is created and the ' +
      'session is upgraded to full access. Decline closes the invite and ' +
      'ends the provisional session.',
  })
  @IsEnum(InviteDecision, {
    message: `decision must be one of: ${Object.values(InviteDecision).join(', ')}`,
  })
  decision: InviteDecision;

  @ApiPropertyOptional({
    example: '66666666-6666-4666-8666-666666666666',
    description:
      'The invite being answered — the id GET /v1/invites/validate-user-invite ' +
      'returned. Required for a full-access session (a member invited to ' +
      'another cohort), so an invite replaced since the member read it is ' +
      'never accepted unseen. A provisional session may omit it to answer ' +
      'the invite its session was issued for. If that one was revoked and ' +
      'replaced, validate-user-invite shows the replacement, and answering ' +
      'it means naming it here; any other id is refused.',
  })
  @IsOptional()
  @IsUUID()
  inviteId?: string;
}

/** The membership an accept created, or restored for a returning member. */
export class MembershipGrantedDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  cohortId: string;

  @ApiProperty({ enum: CohortRole, enumName: 'CohortRole' })
  role: CohortRole;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  cohortTrackId: string | null;

  @ApiPropertyOptional({
    enum: StudentStatus,
    enumName: 'StudentStatus',
    nullable: true,
  })
  status: StudentStatus | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  joinedAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'When this membership stops counting. Set for guests and null for ' +
      'everyone else, so a client can tell a visitor they are here until a ' +
      'date rather than indefinitely.',
  })
  accessExpiresAt: Date | null;
}

/**
 * What the onboarding screen needs to move on: where the invite ended up, the
 * membership that produced, and the role the account now carries. For a
 * browser the session upgrade itself travels in a Set-Cookie header, not in
 * this body — the token is httpOnly precisely so the page never holds it.
 * Only a caller that authenticated with a bearer token is handed `session`.
 */
export class InviteDecisionResponseDto {
  @ApiProperty({ example: '66666666-6666-4666-8666-666666666666' })
  inviteId: string;

  @ApiProperty({
    enum: [InviteStatus.Accepted, InviteStatus.Declined],
    enumName: 'InviteDecisionStatus',
  })
  status: InviteStatus.Accepted | InviteStatus.Declined;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  decidedAt: Date;

  @ApiPropertyOptional({
    type: MembershipGrantedDto,
    nullable: true,
    description: 'Null for a cohort-less admin invite, and for a decline.',
  })
  membership: MembershipGrantedDto | null;

  @ApiPropertyOptional({
    enum: SystemRole,
    enumName: 'SystemRole',
    nullable: true,
    description:
      "The account's role after accepting — the invite is the only channel " +
      'that can grant anything above the default a provisional sign-in gets. ' +
      'Null on decline.',
  })
  systemRole: SystemRole | null;

  @ApiPropertyOptional({
    type: () => SessionTokensDto,
    description:
      'The full-access session an accept upgraded a provisional one to. ' +
      'Present only when the request was authenticated with a bearer token ' +
      'rather than the cookie; replace the provisional token with it. ' +
      'Absent on a decline, and for a full-access caller, who keeps the ' +
      'session they came with.',
  })
  session?: SessionTokensDto;
}
