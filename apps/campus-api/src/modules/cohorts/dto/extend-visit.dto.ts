import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsUUID } from 'class-validator';

export class MemberParamDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  @IsUUID()
  cohortId: string;

  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  @IsUUID()
  userId: string;
}

export class ExtendGuestVisitDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-20T12:00:00.000Z',
    description:
      'When the visit now ends: in the future, and later than the end it ' +
      'already has.',
  })
  @IsDateString()
  accessExpiresAt: string;
}
