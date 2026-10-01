import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AttachTrackDto {
  @ApiProperty({
    example: '33333333-3333-4333-8333-333333333333',
    description: 'A track from GET /v1/tracks.',
  })
  @IsUUID()
  trackId: string;
}

export class CohortIdParamDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  @IsUUID()
  id: string;
}
