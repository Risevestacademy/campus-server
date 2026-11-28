import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AttachmentDto } from '../media/dto/upload.dto.js';
import { CallChatService } from './call-chat.service.js';
import { ApiAttachToCall } from './docs/call-chat.docs.js';
import { AttachToCallDto } from './dto/call-chat.dto.js';
import { CallSpaceParamDto } from './dto/call-space.dto.js';

@ApiTags('calls')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts/:cohortId/spaces/:spaceId/call/attachments')
export class CallChatController {
  constructor(private readonly chat: CallChatService) {}

  @Post()
  @ApiAttachToCall()
  attach(
    @Param() params: CallSpaceParamDto,
    @Body() body: AttachToCallDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentDto> {
    return this.chat.attach(
      user.id,
      params.cohortId,
      params.spaceId,
      body.mediaId,
      new Date(),
    );
  }
}
