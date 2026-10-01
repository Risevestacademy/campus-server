import { ApiProperty } from '@nestjs/swagger';

export class TrackResponseDto {
  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333' })
  id: string;

  @ApiProperty({ example: 'Software Engineering' })
  name: string;

  @ApiProperty({ example: 'SE' })
  code: string;

  @ApiProperty({
    type: String,
    example: 'Backend and infra',
    nullable: true,
  })
  description: string | null;

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
