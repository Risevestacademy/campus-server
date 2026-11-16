import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class PinNoticeDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  pinned: boolean;
}
