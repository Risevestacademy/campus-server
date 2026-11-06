import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { CreateNoticeDto } from './dto/create-notice.dto.js';
import { PinNoticeDto } from './dto/pin-notice.dto.js';
import { NoticeIdParamDto, UpdateNoticeDto } from './dto/update-notice.dto.js';
import type { NoticeResponseDto } from './dto/notice-response.dto.js';
import { NoticesService } from './notices.service.js';

@ApiTags('notices')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateNoticeDto,
    @CurrentUser() actor: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<NoticeResponseDto> {
    return this.notices.create(dto, actor, {
      actorUserId: actor.id,
      correlationId,
    });
  }

  @Patch(':id')
  update(
    @Param() params: NoticeIdParamDto,
    @Body() dto: UpdateNoticeDto,
    @CurrentUser() actor: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<NoticeResponseDto> {
    return this.notices.update(params.id, dto, actor, {
      actorUserId: actor.id,
      correlationId,
    });
  }

  @Patch(':id/pin')
  pin(
    @Param() params: NoticeIdParamDto,
    @Body() dto: PinNoticeDto,
    @CurrentUser() actor: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<NoticeResponseDto> {
    return this.notices.pin(params.id, dto.pinned, actor, {
      actorUserId: actor.id,
      correlationId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param() params: NoticeIdParamDto,
    @CurrentUser() actor: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.notices.remove(params.id, actor, {
      actorUserId: actor.id,
      correlationId,
    });
  }
}
