import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AttachToCallDto {
  /** From `POST /v1/uploads` with kind `call_chat_attachment`, after the file was PUT. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  mediaId: string;
}
