import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { PaginationQueryDto } from '../../shared/dto/pagination-query.dto.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiAddNoticeComment,
  ApiListNoticeComments,
  ApiListNotices,
} from './docs/notices.docs.js';
import { ListNoticesQueryDto } from './dto/list-notices.dto.js';
import {
  CreateNoticeCommentDto,
  NoticeCommentDto,
  NoticeIdParamDto,
} from './dto/notice-comment.dto.js';
import { NoticeResponseDto } from './dto/notice-response.dto.js';
import {
  COMMENT_RATE_LIMIT,
  COMMENT_RATE_WINDOW_MS,
  NoticeCommentsService,
} from './notice-comments.service.js';
import { NoticesService } from './notices.service.js';

@ApiTags('notices')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @ApiListNotices()
  list(
    @CurrentUser() viewer: AuthenticatedUser,
    @Query() query: ListNoticesQueryDto,
  ): Promise<PaginatedResponseDto<NoticeResponseDto>> {
    return this.notices.list(viewer, query);
  }
}

@ApiTags('notices')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('notices/:id/comments')
export class NoticeCommentsController {
  constructor(private readonly comments: NoticeCommentsService) {}

  @Get()
  @ApiListNoticeComments()
  list(
    @Param() params: NoticeIdParamDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<NoticeCommentDto>> {
    return this.comments.list(viewer, params.id, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({
    default: { limit: COMMENT_RATE_LIMIT, ttl: COMMENT_RATE_WINDOW_MS },
  })
  @ApiAddNoticeComment()
  add(
    @Param() params: NoticeIdParamDto,
    @Body() dto: CreateNoticeCommentDto,
    @CurrentUser() viewer: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<NoticeCommentDto> {
    return this.comments.add(viewer, params.id, dto, {
      actorUserId: viewer.id,
      correlationId,
    });
  }
}
