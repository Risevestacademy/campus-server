import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const INVITE_FLAG_MESSAGE_MAX_LENGTH = 1000;

export class InviteFlagDto {
  @ApiProperty({
    example:
      'I applied for the Product Design track, not Software Engineering.',
    maxLength: INVITE_FLAG_MESSAGE_MAX_LENGTH,
    description:
      'What is wrong with the invite, in the invitee’s own words. Sent to ' +
      'the admin as written, so it has to say something: blank is refused.',
  })
  // Trimmed first, so a message of spaces is empty rather than a flag that
  // tells the admin nothing. NUL goes too: Postgres refuses it in text, and
  // that would be a 500 for a character nobody can see.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : value,
  )
  // Checked bottom-up, and only the first failure is reported: emptiness
  // first, or a missing message is described as too long.
  @MaxLength(INVITE_FLAG_MESSAGE_MAX_LENGTH)
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional({
    example: '66666666-6666-4666-8666-666666666666',
    description:
      'The invite being flagged — the id GET /v1/invites/validate-user-invite ' +
      'returned. Named under the same rule as POST /v1/invites/decision: ' +
      'required for a full-access session, optional for a provisional one, ' +
      'which otherwise flags the invite its session was issued for.',
  })
  @IsOptional()
  @IsUUID()
  inviteId?: string;
}

/** The receipt for a flag: which invite, and when it was recorded. */
export class InviteFlagResponseDto {
  @ApiProperty({ example: '66666666-6666-4666-8666-666666666666' })
  inviteId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-03T12:00:00.000Z',
  })
  flaggedAt: Date;
}
