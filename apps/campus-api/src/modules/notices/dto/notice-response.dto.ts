import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { NoticeScope } from '../schema.js';

export class NoticeResponseDto {
  @ApiProperty({ example: '44444444-4444-4444-8444-444444444444' })
  id: string;

  @ApiProperty({ example: '99999999-9999-4999-8999-999999999999' })
  authorId: string;

  @ApiProperty({ enum: NoticeScope, example: NoticeScope.Campus })
  scope: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '11111111-1111-4111-8111-111111111111',
  })
  cohortId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '22222222-2222-4222-8222-222222222222',
  })
  cohortTrackId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '33333333-3333-4333-8333-333333333333',
  })
  mentorshipGroupId: string | null;

  @ApiProperty({ example: 'Campus closed Friday' })
  title: string;

  @ApiProperty({ example: 'The campus will be closed for maintenance.' })
  body: string;

  @ApiProperty({ example: false })
  pinned: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T12:00:00.000Z',
  })
  updatedAt: Date;
}
